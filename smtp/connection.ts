import { Buffer } from 'buffer';
import console from 'console';
import { createHmac } from 'crypto';
import { EventEmitter } from 'events';
import { Socket } from 'net';
import { hostname } from 'os';
import { setTimeout } from 'timers';
import { connect, createSecureContext, TLSSocket } from 'tls';
import type { ConnectionOptions } from 'tls';

import { SMTPError, SMTPErrorStates } from './error.js';
import { SMTPResponseMonitor } from './response.js';

/**
 * @constant
 * @enum {string}
 */
export const AUTH_METHODS = {
	PLAIN: 'PLAIN',
	'CRAM-MD5': 'CRAM-MD5',
	LOGIN: 'LOGIN',
	XOAUTH2: 'XOAUTH2',
} as const;

/**
 * @constant
 * @enum {number}
 */
export const SMTPState = {
	NOTCONNECTED: 0,
	CONNECTING: 1,
	CONNECTED: 2,
} as const;

export const DEFAULT_TIMEOUT = 5000 as const;

const SMTP_PORT = 25 as const;
const SMTP_SSL_PORT = 465 as const;
const SMTP_TLS_PORT = 587 as const;
const CRLF = '\r\n' as const;
const GREYLIST_DELAY = 300 as const;

let DEBUG: 0 | 1 = 0;

/**
 * @param {...unknown[]} args the message(s) to log
 * @returns {void}
 */
const log = (...args: unknown[]) => {
	if (DEBUG === 1) {
		args.forEach((d) =>
			console.log(
				typeof d === 'object'
					? d instanceof Error
						? d.message
						: JSON.stringify(d)
					: d
			)
		);
	}
};

export type SMTPSocketOptions = Omit<
	ConnectionOptions,
	'port' | 'host' | 'path' | 'socket' | 'timeout' | 'secureContext'
>;

export type SMTPCommandCallback = (
	err: Error | SMTPError | null,
	data?:
		| string
		| { code: string | number; data: string; message: string }
		| null,
	message?: string
) => void;

export interface SMTPConnectionOptions {
	timeout: number | null;
	user: string;
	password: string;
	domain: string;
	host: string;
	port: number;
	ssl: boolean | SMTPSocketOptions;
	tls: boolean | SMTPSocketOptions;
	authentication: (keyof typeof AUTH_METHODS)[];
	logger: (...args: unknown[]) => void;
}

export interface ConnectOptions {
	ssl?: boolean;
}

export class SMTPConnection extends EventEmitter {
	public readonly user: () => string;
	public readonly password: () => string;
	public readonly timeout: number = DEFAULT_TIMEOUT;

	protected readonly log = log;
	protected readonly authentication: (keyof typeof AUTH_METHODS)[] = [
		AUTH_METHODS['CRAM-MD5'],
		AUTH_METHODS.LOGIN,
		AUTH_METHODS.PLAIN,
		AUTH_METHODS.XOAUTH2,
	];

	/** @type {SMTPState} */
	protected _state: 0 | 1 | 2 = SMTPState.NOTCONNECTED;
	protected _secure = false;
	protected loggedin = false;

	protected sock: Socket | TLSSocket | null = null;
	protected features: { [index: string]: string | boolean } | null = null;
	protected monitor: SMTPResponseMonitor | null = null;
	protected domain = hostname();
	protected host = 'localhost';
	protected ssl: boolean | SMTPSocketOptions = false;
	protected tls: boolean | SMTPSocketOptions = false;
	protected port: number;

	private greylistResponseTracker = new WeakSet<SMTPCommandCallback>();

	/**
	 * SMTP class written using python's (2.7) smtplib.py as a base.
	 *
	 * To target a Message Transfer Agent (MTA), omit all options.
	 *
	 * @note `host` is trimmed before being used to establish a connection; however, the original untrimmed value will still be visible in configuration.
	 *
	 * @param {Partial<SMTPConnectionOptions>} options
	 */
	constructor({
		timeout,
		host,
		user,
		password,
		domain,
		port,
		ssl,
		tls,
		logger,
		authentication,
	}: Partial<SMTPConnectionOptions> = {}) {
		super();

		if (Array.isArray(authentication)) {
			this.authentication = authentication;
		}

		if (typeof timeout === 'number') {
			this.timeout = timeout;
		}

		if (typeof domain === 'string') {
			this.domain = domain;
		}

		if (typeof host === 'string') {
			this.host = host;
		}

		if (
			ssl != null &&
			(typeof ssl === 'boolean' ||
				(typeof ssl === 'object' && Array.isArray(ssl) === false))
		) {
			this.ssl = ssl;
		}

		if (
			tls != null &&
			(typeof tls === 'boolean' ||
				(typeof tls === 'object' && Array.isArray(tls) === false))
		) {
			this.tls = tls;
		}

		this.port = port || (ssl ? SMTP_SSL_PORT : tls ? SMTP_TLS_PORT : SMTP_PORT);
		this.loggedin = user && password ? false : true;

		if (!user && (password?.length ?? 0) > 0) {
			throw new Error('`password` cannot be set without `user`');
		}

		// keep these strings hidden when quicky debugging/logging
		this.user = () => user as string;
		this.password = () => password as string;

		if (typeof logger === 'function') {
			this.log = logger;
		}
	}

	/**
	 * @public
	 * @param {0 | 1} level
	 * @returns {void}
	 */
	public debug(level: 0 | 1) {
		DEBUG = level;
	}

	/**
	 * @public
	 * @returns {SMTPState}
	 */
	public state() {
		return this._state;
	}

	/**
	 * @public
	 * @returns {boolean}
	 */
	public authorized() {
		return this.loggedin;
	}

	/**
	 * Establish an SMTP connection.
	 *
	 * @note `host` is trimmed before being used to establish a connection; however, the original untrimmed value will still be visible in configuration.
	 *
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @param {number} [port]
	 * @param {string} [host]
	 * @param {ConnectOptions} [options={}]
	 * @returns {void}
	 */
	public connect(
		callback: SMTPCommandCallback,
		port: number = this.port,
		host: string = this.host,
		options: ConnectOptions = {}
	) {
		this.port = port;
		this.host = host;
		this.ssl = options.ssl || this.ssl;

		if (this._state !== SMTPState.NOTCONNECTED) {
			this.quit(() => this.connect(callback, port, host, options));
		}

		/**
		 * @returns {void}
		 */
		const connected = () => {
			this.log(`connected: ${this.host}:${this.port}`);

			if (this.ssl && !this.tls) {
				// if key/ca/cert was passed in, check if connection is authorized
				if (
					typeof this.ssl !== 'boolean' &&
					this.sock instanceof TLSSocket &&
					!this.sock.authorized
				) {
					this.close(true);
					callback(
						SMTPError.create(
							'could not establish an ssl connection',
							SMTPErrorStates.CONNECTIONAUTH
						)
					);
				} else {
					this._secure = true;
				}
			}
		};

		/**
		 * @param {Error} err
		 * @returns {void}
		 */
		const connectedErrBack = (err?: Error) => {
			if (!err) {
				connected();
			} else {
				this.close(true);
				this.log(err);
				callback(
					SMTPError.create(
						'could not connect',
						SMTPErrorStates.COULDNOTCONNECT,
						err
					)
				);
			}
		};

		const response = (
			err: Error | null | undefined,
			msg: { code: string | number; data: string }
		) => {
			if (err) {
				if (this._state === SMTPState.NOTCONNECTED && !this.sock) {
					return;
				}
				this.close(true);
				callback(err);
			} else if (msg.code == '220') {
				this.log(msg.data);

				// might happen first, so no need to wait on connected()
				this._state = SMTPState.CONNECTED;
				callback(null, msg.data);
			} else {
				this.log(`response (data): ${msg.data}`);
				this.quit(() => {
					callback(
						SMTPError.create(
							'bad response on connection',
							SMTPErrorStates.BADRESPONSE,
							err,
							msg.data
						)
					);
				});
			}
		};

		this._state = SMTPState.CONNECTING;
		this.log(`connecting: ${this.host}:${this.port}`);

		if (this.ssl) {
			this.sock = connect(
				this.port,
				this.host.trim(),
				typeof this.ssl === 'object' ? this.ssl : {},
				connected
			);
		} else {
			this.sock = new Socket();
			this.sock.connect(this.port, this.host.trim(), connectedErrBack);
		}

		this.monitor = new SMTPResponseMonitor(this.sock, this.timeout, () =>
			this.close(true)
		);
		this.sock.once('response', response);
		this.sock.once('error', response); // the socket could reset or throw, so let's handle it and let the user know
	}

	/**
	 * @public
	 * @param {string} str
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public send(str: string, callback: SMTPCommandCallback) {
		if (this.sock != null && this._state === SMTPState.CONNECTED) {
			this.log(str);

			this.sock.once('response', (err, msg) => {
				if (err) {
					callback(err, undefined);
				} else {
					this.log(msg.data);
					callback(null, msg);
				}
			});
			if (this.sock.writable) {
				this.sock.write(str);
			}
		} else {
			this.close(true);
			callback(
				SMTPError.create(
					'no connection has been established',
					SMTPErrorStates.NOCONNECTION
				),
				undefined
			);
		}
	}

	/**
	 * @public
	 * @param {string} cmd
	 * @param {SMTPCommandCallback} callback
	 * @param {(number[] | number)} [codes=[250]] SMTP response code(s)
	 * @returns {void}
	 */
	public command(
		cmd: string,
		callback: SMTPCommandCallback,
		codes: number[] | number = [250]
	) {
		const codesArray = Array.isArray(codes)
			? codes
			: typeof codes === 'number'
			? [codes]
			: [250];

		const response: SMTPCommandCallback = (err, msg) => {
			if (err) {
				callback(err);
			} else if (msg == null || typeof msg === 'string') {
				callback(
					SMTPError.create(
						'Invalid message in response',
						SMTPErrorStates.BADRESPONSE,
						err,
						msg
					)
				);
			} else {
				const code = Number(msg.code);
				if (codesArray.indexOf(code) !== -1) {
					callback(err, msg.data, msg.message);
				} else if (
					(code === 450 || code === 451) &&
					msg.message.toLowerCase().includes('greylist') &&
					this.greylistResponseTracker.has(response) === false
				) {
					this.greylistResponseTracker.add(response);
					setTimeout(() => {
						this.send(cmd + CRLF, response);
					}, GREYLIST_DELAY);
				} else {
					const suffix = msg.message ? `: ${msg.message}` : '';
					const errorMessage = `bad response on command '${
						cmd.split(' ')[0]
					}'${suffix}`;
					callback(
						SMTPError.create(
							errorMessage,
							SMTPErrorStates.BADRESPONSE,
							null,
							msg.data
						)
					);
				}
			}
		};

		this.greylistResponseTracker.delete(response);
		this.send(cmd + CRLF, response);
	}

	/**
	 * @public
	 * @description SMTP 'helo' command.
	 *
	 * Hostname to send for self command defaults to the FQDN of the local
	 * host.
	 *
	 * As this command was deprecated by rfc2821, it should only be used for compatibility with non-compliant servers.
	 * @see https://tools.ietf.org/html/rfc2821#appendix-F.3
	 *
	 * @param {SMTPCommandCallback} callback
	 * @param {string} [domain]
	 * @returns {void}
	 */
	public helo(callback: SMTPCommandCallback, domain?: string) {
		this.command(`helo ${domain || this.domain}`, (err, data) => {
			if (err) {
				callback(err);
			} else {
				this.parse_smtp_features(data as string);
				callback(err, data);
			}
		});
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public starttls(callback: SMTPCommandCallback) {
		const response: SMTPCommandCallback = (err, msg) => {
			if (this.sock == null) {
				throw new Error('null socket');
			}

			if (err) {
				err.message += ' while establishing a starttls session';
				callback(err);
			} else {
				const secureContext = createSecureContext(
					typeof this.tls === 'object' ? this.tls : {}
				);
				const secureSocket = new TLSSocket(this.sock, { secureContext });

				secureSocket.on('error', (err: Error) => {
					this.close(true);
					callback(err);
				});

				this._secure = true;
				this.sock = secureSocket;

				new SMTPResponseMonitor(this.sock, this.timeout, () =>
					this.close(true)
				);
				callback(null, typeof msg === 'string' ? msg : msg?.data);
			}
		};

		this.command('starttls', response, [220]);
	}

	/**
	 * @public
	 * @param {string} data
	 * @returns {void}
	 */
	public parse_smtp_features(data: string) {
		//  According to RFC1869 some (badly written)
		//  MTA's will disconnect on an ehlo. Toss an exception if
		//  that happens -ddm

		data.split('\n').forEach((ext) => {
			const parse = ext.match(/^(?:\d+[-=]?)\s*?([^\s]+)(?:\s+(.*)\s*?)?$/);

			// To be able to communicate with as many SMTP servers as possible,
			// we have to take the old-style auth advertisement into account,
			// because:
			// 1) Else our SMTP feature parser gets confused.
			// 2) There are some servers that only advertise the auth methods we
			// support using the old style.

			if (parse != null && this.features != null) {
				// RFC 1869 requires a space between ehlo keyword and parameters.
				// It's actually stricter, in that only spaces are allowed between
				// parameters, but were not going to check for that here.  Note
				// that the space isn't present if there are no parameters.
				this.features[parse[1].toLowerCase()] = parse[2] || true;
			}
		});
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @param {string} [domain]
	 * @returns {void}
	 */
	public ehlo(callback: SMTPCommandCallback, domain?: string) {
		this.features = {};
		this.command(`ehlo ${domain || this.domain}`, (err, data) => {
			if (err) {
				callback(err);
			} else {
				this.parse_smtp_features(data as string);

				if (this.tls && !this._secure) {
					this.starttls(() => this.ehlo(callback, domain));
				} else {
					callback(err, data);
				}
			}
		});
	}

	/**
	 * @public
	 * @param {string} opt the features keyname to check
	 * @returns {boolean}
	 */
	public has_extn(opt: string) {
		return (this.features ?? {})[opt.toLowerCase()] === undefined;
	}

	/**
	 * @public
	 * @description SMTP 'help' command, returns text from the server
	 * @param {SMTPCommandCallback} callback
	 * @param {string} domain
	 * @returns {void}
	 */
	public help(callback: SMTPCommandCallback, domain: string) {
		this.command(domain ? `help ${domain}` : 'help', callback, [211, 214]);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public rset(callback: SMTPCommandCallback) {
		this.command('rset', callback);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public noop(callback: SMTPCommandCallback) {
		this.send('noop', callback);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @param {string} from the sender
	 * @returns {void}
	 */
	public mail(callback: SMTPCommandCallback, from: string) {
		this.command(`mail FROM:${from}`, callback);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @param {string} to the receiver
	 * @returns {void}
	 */
	public rcpt(callback: SMTPCommandCallback, to: string) {
		this.command(`RCPT TO:${to}`, callback, [250, 251]);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public data(callback: SMTPCommandCallback) {
		this.command('data', callback, [354]);
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public data_end(callback: SMTPCommandCallback) {
		this.command(`${CRLF}.`, callback);
	}

	/**
	 * @public
	 * @param {string} data the message to send
	 * @returns {void}
	 */
	public message(data: string) {
		this.log(data);
		this.sock?.write(data) ?? this.log('no socket to write to');
	}

	/**
	 * @public
	 * @description SMTP 'verify' command -- checks for address validity.
	 * @param {string} address
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public verify(address: string, callback: SMTPCommandCallback) {
		this.command(`vrfy ${address}`, callback, [250, 251, 252]);
	}

	/**
	 * @public
	 * @description SMTP 'expn' command -- expands a mailing list.
	 * @param {string} address
	 * @param {SMTPCommandCallback} callback
	 * @returns {void}
	 */
	public expn(address: string, callback: SMTPCommandCallback) {
		this.command(`expn ${address}`, callback);
	}

	/**
	 * @public
	 * @description Calls this.ehlo() and, if an error occurs, this.helo().
	 *
	 * If there has been no previous EHLO or HELO command self session, self
	 * method tries ESMTP EHLO first.
	 *
	 * @param {SMTPCommandCallback} callback
	 * @param {string} [domain] the domain to associate with the command
	 * @returns {void}
	 */
	public ehlo_or_helo_if_needed(
		callback: SMTPCommandCallback,
		domain?: string
	) {
		if (!this.features) {
			this.ehlo((err, data) => {
				if (err) {
					this.helo(callback, domain);
				} else {
					callback(err, data);
				}
			}, domain);
		}
	}

	/**
	 * @public
	 *
	 * Log in on an SMTP server that requires authentication.
	 *
	 * If there has been no previous EHLO or HELO command self session, self
	 * method tries ESMTP EHLO first.
	 *
	 * This method will return normally if the authentication was successful.
	 *
	 * @param {SMTPCommandCallback} callback
	 * @param {string} [user]
	 * @param {string} [password]
	 * @param {Object} [options]
	 * @param {string} [options.method]
	 * @param {string} [options.domain]
	 * @returns {void}
	 */
	public login(
		callback: SMTPCommandCallback,
		user?: string,
		password?: string,
		options: { method?: string; domain?: string } = {}
	) {
		const login = {
			user: user ? () => user : this.user,
			password: password ? () => password : this.password,
			method: options?.method?.toUpperCase() ?? '',
		};

		const domain = options?.domain || this.domain;

		/**
		 * @param {Error | null} err
		 * @param {unknown} data
		 * @returns {void}
		 */
		const initiate = (err: Error | null | undefined, data: unknown) => {
			if (err) {
				callback(err);
				return;
			}

			let method: keyof typeof AUTH_METHODS | null = null;

			/**
			 * @param {string} challenge
			 * @returns {string} base64 cram hash
			 */
			const encodeCramMd5 = (challenge: string) => {
				const hmac = createHmac('md5', login.password());
				hmac.update(Buffer.from(challenge, 'base64').toString('ascii'));
				return Buffer.from(`${login.user()} ${hmac.digest('hex')}`).toString(
					'base64'
				);
			};

			/**
			 * @returns {string} base64 login/password
			 */
			const encodePlain = () =>
				Buffer.from(`\u0000${login.user()}\u0000${login.password()}`).toString(
					'base64'
				);

			/**
			 * @see https://developers.google.com/gmail/xoauth2_protocol
			 * @returns {string} base64 xoauth2 auth token
			 */
			const encodeXoauth2 = () =>
				Buffer.from(
					`user=${login.user()}\u0001auth=Bearer ${login.password()}\u0001\u0001`
				).toString('base64');

			// List of authentication methods we support: from preferred to
			// less preferred methods.
			if (!method) {
				const preferred = this.authentication;
				let auth = '';

				if (
					this.features != null &&
					typeof this.features['auth'] === 'string'
				) {
					auth = this.features['auth'];
				}

				for (let i = 0; i < preferred.length; i++) {
					if (auth.includes(preferred[i])) {
						method = preferred[i];
						break;
					}
				}
			}

			/**
			 * handle bad responses from command differently
			 * @param {Error | SMTPError | null} err
			 * @param {(
			 * 	string |
			 * 	{ code: (string | number), data: string, message: string } |
			 * 	null
			 * )} [data]
			 * @returns {void}
			 */
			const failed: SMTPCommandCallback = (err, data) => {
				this.loggedin = false;
				this.close(); // if auth is bad, close the connection, it won't get better by itself
				callback(
					SMTPError.create(
						'authorization.failed',
						SMTPErrorStates.AUTHFAILED,
						err,
						data
					)
				);
			};

			/**
			 * @param {Error | SMTPError | null} err
			 * @param {(
			 * 	string |
			 * 	{ code: (string | number), data: string, message: string } |
			 * 	null
			 * )} [data]
			 * @returns {void}
			 */
			const response: SMTPCommandCallback = (err, data) => {
				if (err) {
					failed(err, data);
				} else {
					this.loggedin = true;
					callback(err, data);
				}
			};

			/**
			 * @param {Error | SMTPError | null} err
			 * @param {(
			 * 	string |
			 * 	{ code: (string | number), data: string, message: string } |
			 * 	null
			 * )} data
			 * @param {string} msg
			 * @returns {void}
			 */
			const attempt: SMTPCommandCallback = (err, data, msg) => {
				if (err) {
					failed(err, data);
				} else {
					if (method === AUTH_METHODS['CRAM-MD5']) {
						this.command(encodeCramMd5(msg as string), response, [235, 503]);
					} else if (method === AUTH_METHODS.LOGIN) {
						this.command(
							Buffer.from(login.password()).toString('base64'),
							response,
							[235, 503]
						);
					}
				}
			};

			/**
			 * @param {Error | SMTPError | null} err
			 * @param {(
			 * 	string |
			 * 	{ code: (string | number), data: string, message: string } |
			 * 	null
			 * )} [data]
			 * @returns {void}
			 */
			const attemptUser: SMTPCommandCallback = (err, data) => {
				if (err) {
					failed(err, data);
				} else {
					if (method === AUTH_METHODS.LOGIN) {
						this.command(
							Buffer.from(login.user()).toString('base64'),
							attempt,
							[334]
						);
					}
				}
			};

			switch (method) {
				case AUTH_METHODS['CRAM-MD5']:
					this.command(`AUTH  ${AUTH_METHODS['CRAM-MD5']}`, attempt, [334]);
					break;
				case AUTH_METHODS.LOGIN:
					this.command(`AUTH ${AUTH_METHODS.LOGIN}`, attemptUser, [334]);
					break;
				case AUTH_METHODS.PLAIN:
					this.command(
						`AUTH ${AUTH_METHODS.PLAIN} ${encodePlain()}`,
						response,
						[235, 503]
					);
					break;
				case AUTH_METHODS.XOAUTH2:
					this.command(
						`AUTH ${AUTH_METHODS.XOAUTH2} ${encodeXoauth2()}`,
						response,
						[235, 503]
					);
					break;
				default:
					callback(
						SMTPError.create(
							'no form of authorization supported',
							SMTPErrorStates.AUTHNOTSUPPORTED,
							null,
							data
						)
					);
					break;
			}
		};

		this.ehlo_or_helo_if_needed(initiate, domain);
	}

	/**
	 * @public
	 * @param {boolean} [force=false]
	 * @returns {void}
	 */
	public close(force = false) {
		if (this.sock) {
			if (force) {
				this.log('smtp connection destroyed!');
				this.sock.destroy();
			} else {
				this.log('smtp connection closed.');
				this.sock.end();
			}
		}

		if (this.monitor) {
			this.monitor.stop();
			this.monitor = null;
		}

		this._state = SMTPState.NOTCONNECTED;
		this._secure = false;
		this.sock = null;
		this.features = null;
		this.loggedin = !(this.user() && this.password());
	}

	/**
	 * @public
	 * @param {SMTPCommandCallback} [callback]
	 * @returns {void}
	 */
	public quit(callback?: SMTPCommandCallback) {
		this.command(
			'quit',
			(err, data) => {
				callback?.(err, data);
				this.close();
			},
			[221, 250]
		);
	}
}
