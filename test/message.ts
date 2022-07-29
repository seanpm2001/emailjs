import { createReadStream, readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { URL } from 'url';

import test from 'ava';
import type { ExecutionContext, LogFn } from 'ava';
import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';
import { SMTPServer } from 'smtp-server';

import { SMTPClient, Message } from '../email.js';
import type { MessageAttachment, MessageHeaders } from '../email.js';

const textFixtureUrl = new URL('attachments/smtp.txt', import.meta.url);
const textFixture = readFileSync(textFixtureUrl, 'utf-8');

const htmlFixtureUrl = new URL('attachments/smtp.html', import.meta.url);
const htmlFixture = readFileSync(htmlFixtureUrl, 'utf-8');

const pdfFixtureUrl = new URL('attachments/smtp.pdf', import.meta.url);
const pdfFixture = readFileSync(pdfFixtureUrl, 'base64');

const tarFixtureUrl = new URL(
	'attachments/postfix-2.8.7.tar.gz',
	import.meta.url
);
const tarFixture = readFileSync(tarFixtureUrl, 'base64');

/**
 * \@types/mailparser\@3.0.2 breaks our code
 * @see https://github.com/DefinitelyTyped/DefinitelyTyped/pull/50744
 */
type ParsedMailCompat = Omit<ParsedMail, 'to'> & { to?: AddressObject };

const port = 5555;

const parseMap = new Map<string, ParsedMailCompat>();
const logFnMap = new Map<string, LogFn>();
const server = new SMTPServer({
	secure: true,
	onAuth(auth, _session, callback) {
		if (auth.username == 'pooh' && auth.password == 'honey') {
			callback(null, { user: 'pooh' });
		} else {
			return callback(new Error('invalid user / pass'));
		}
	},
	async onData(stream, _session, callback) {
		const now = performance.now();
		const mail = (await simpleParser(stream, {
			skipHtmlToText: true,
			skipTextToHtml: true,
			skipImageLinks: true,
		})) as ParsedMailCompat;
		const { subject = '' } = mail;
		(logFnMap.get(subject) as LogFn)(
			`Time to parse message: ${Math.round(performance.now() - now)}ms`
		);
		parseMap.set(subject, mail);
		callback();
	},
});

test.before((t) => server.listen(port, t.pass));
test.after((t) => server.close(t.pass));

function send(t: ExecutionContext, headers: Partial<MessageHeaders>) {
	return new Promise<ParsedMailCompat>((resolve, reject) => {
		const { subject = t.title } = headers;
		headers.subject = subject;
		logFnMap.set(subject, t.log);

		const client = new SMTPClient({
			port,
			user: 'pooh',
			password: 'honey',
			ssl: true,
		});
		client.send(new Message(headers), (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(parseMap.get(subject) as ParsedMailCompat);
			}
		});
	});
}

test('simple text message', async (t) => {
	const msg = {
		from: 'zelda@gmail.com',
		to: 'gannon@gmail.com',
		cc: 'gannon@gmail.com',
		bcc: 'gannon@gmail.com',
		text: 'hello friend, i hope this message finds you well.',
		'message-id': 'special id',
	};

	const mail = await send(t, msg);
	t.is(mail.text, msg.text + '\n\n\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
	t.is(mail.messageId, '<' + msg['message-id'] + '>');
});

test('null text message', async (t) => {
	const msg = {
		from: 'zelda@gmail.com',
		to: 'gannon@gmail.com',
		text: null,
		'message-id': 'special id',
	};

	const mail = await send(t, msg);
	t.is(mail.text, '\n\n\n');
});

test('empty text message', async (t) => {
	const msg = {
		from: 'zelda@gmail.com',
		to: 'gannon@gmail.com',
		text: '',
		'message-id': 'special id',
	};

	const mail = await send(t, msg);
	t.is(mail.text, '\n\n\n');
});

test('simple ✓ unicode ✓ text message', async (t) => {
	const msg = {
		from: 'zelda✓ <zelda@gmail.com>',
		to: 'gannon✓ <gannon@gmail.com>',
		text: 'hello ✓ friend, i hope this message finds you well.',
	};

	const mail = await send(t, msg);
	t.is(mail.text, msg.text + '\n\n\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('very large text message', async (t) => {
	// thanks to jart+loberstech for this one!
	const msg = {
		from: 'ninjas@gmail.com',
		to: 'pirates@gmail.com',
		text: textFixture,
	};

	const mail = await send(t, msg);
	t.is(mail.text, msg.text.replace(/\r/g, '') + '\n\n\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('very large text + data message', async (t) => {
	const text = '<html><body><pre>' + textFixture + '</pre></body></html>';

	const msg = {
		from: 'lobsters@gmail.com',
		to: 'lizards@gmail.com',
		text: 'hello friend if you are seeing this, you can not view html emails. it is attached inline.',
		attachment: {
			data: text,
			alternative: true,
		},
	};

	const mail = await send(t, msg);
	t.is(mail.html, text.replace(/\r/g, ''));
	t.is(mail.text, msg.text + '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('text + html + data message', async (t) => {
	const msg = {
		from: 'obama@gmail.com',
		to: 'mitt@gmail.com',
		attachment: {
			data: htmlFixture,
			alternative: true,
		},
	};

	const mail = await send(t, msg);
	t.is(mail.html, htmlFixture.replace(/\r/g, ''));
	t.is(mail.text, '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('html file message', async (t) => {
	const msg = {
		from: 'thomas@gmail.com',
		to: 'nikolas@gmail.com',
		attachment: {
			path: new URL('attachments/smtp.html', import.meta.url),
			alternative: true,
		},
	};

	const mail = await send(t, msg);
	t.is(mail.html, htmlFixture.replace(/\r/g, ''));
	t.is(mail.text, '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('html + image embed message', async (t) => {
	const htmlFixture2Url = new URL('attachments/smtp2.html', import.meta.url);
	const imageFixtureUrl = new URL('attachments/smtp.gif', import.meta.url);
	const msg = {
		from: 'ninja@gmail.com',
		to: 'pirate@gmail.com',
		attachment: {
			path: htmlFixture2Url,
			alternative: true,
			related: [
				{
					path: imageFixtureUrl,
					type: 'image/gif',
					name: 'smtp-diagram.gif',
					headers: { 'Content-ID': '<smtp-diagram@local>' },
				},
			],
		},
	};

	const mail = await send(t, msg);
	t.is(
		mail.attachments[0].content.toString('base64'),
		readFileSync(imageFixtureUrl, 'base64')
	);
	t.is(mail.html, readFileSync(htmlFixture2Url, 'utf-8').replace(/\r/g, ''));
	t.is(mail.text, '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('html + data + two attachments message', async (t) => {
	const msg = {
		from: 'thomas@gmail.com',
		to: 'nikolas@gmail.com',
		attachment: [
			{
				path: new URL('attachments/smtp.html', import.meta.url),
				alternative: true,
			},
			{ path: new URL('attachments/smtp.gif', import.meta.url) },
		] as MessageAttachment[],
	};

	const mail = await send(t, msg);
	t.is(mail.html, htmlFixture.replace(/\r/g, ''));
	t.is(mail.text, '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('text + attachment message', async (t) => {
	const msg = {
		from: 'washing@gmail.com',
		to: 'lincoln@gmail.com',
		text: 'hello friend, i hope this message and pdf finds you well.',
		attachment: {
			path: pdfFixtureUrl,
			type: 'application/pdf',
			name: 'smtp-info.pdf',
		} as MessageAttachment,
	};

	const mail = await send(t, msg);
	t.is(mail.attachments[0].content.toString('base64'), pdfFixture);
	t.is(mail.text, msg.text + '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('text + attachment + unicode filename message', async (t) => {
	const msg = {
		from: 'washing@gmail.com',
		to: 'lincoln@gmail.com',
		text: 'hello friend, i hope this message and pdf finds you well.',
		attachment: {
			path: pdfFixtureUrl,
			type: 'application/pdf',
			name: 'smtp-✓-info.pdf',
		} as MessageAttachment,
	};

	const mail = await send(t, msg);
	t.is(mail.attachments[0].content.toString('base64'), pdfFixture);
	t.is(mail.attachments[0].filename, 'smtp-✓-info.pdf');
	t.is(mail.text, msg.text + '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('text + two attachments message', async (t) => {
	const msg = {
		from: 'sergey@gmail.com',
		to: 'jobs@gmail.com',
		text: 'hello friend, i hope this message and attachments finds you well.',
		attachment: [
			{
				path: pdfFixtureUrl,
				type: 'application/pdf',
				name: 'smtp-info.pdf',
			},
			{
				path: tarFixtureUrl,
				type: 'application/tar-gz',
				name: 'postfix.source.2.8.7.tar.gz',
			},
		] as MessageAttachment[],
	};

	const mail = await send(t, msg);
	t.is(mail.attachments[0].content.toString('base64'), pdfFixture);
	t.is(mail.attachments[1].content.toString('base64'), tarFixture);
	t.is(mail.text, msg.text + '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('text + two attachments message (streams)', async (t) => {
	const msg = {
		from: 'stanford@gmail.com',
		to: 'mit@gmail.com',
		text: 'hello friend, i hope this message and streamed attachments finds you well.',
		attachment: [
			{
				stream: createReadStream(pdfFixtureUrl),
				type: 'application/pdf',
				name: 'smtp-info.pdf',
			},
			{
				stream: createReadStream(tarFixtureUrl),
				type: 'application/x-gzip',
				name: 'postfix.source.2.8.7.tar.gz',
			},
		],
	};

	for (const { stream } of msg.attachment) {
		stream.pause();
	}

	const mail = await send(t, msg);
	t.is(mail.attachments[0].content.toString('base64'), pdfFixture);
	t.is(mail.attachments[1].content.toString('base64'), tarFixture);
	t.is(mail.text, msg.text + '\n');
	t.is(mail.subject, t.title);
	t.is(mail.from?.text, msg.from);
	t.is(mail.to?.text, msg.to);
});

test('message validation succeeds when `from` header is an array', async (t) => {
	const msg = new Message({
		from: ['zelda@gmail.com'],
		to: 'gannon1@gmail.com',
	});

	t.false(Array.isArray(msg.header.from));

	msg.header.from = [msg.header.from as string];
	const { isValid } = msg.checkValidity();

	t.true(Array.isArray(msg.header.from));
	t.true(isValid);
});

test('message validation fails without `from` header', async (t) => {
	const msg = new Message({});
	const { isValid, validationError } = msg.checkValidity();
	t.false(isValid);
	t.is(validationError, 'Message must have a `from` header');
});

test('message validation fails without `to`, `cc`, or `bcc` header', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
	}).checkValidity();

	t.false(isValid);
	t.is(
		validationError,
		'Message must have at least one `to`, `cc`, or `bcc` header'
	);
});

test('message validation succeeds with only `to` recipient header (string)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		to: 'pooh@gmail.com',
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});

test('message validation succeeds with only `to` recipient header (array)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		to: ['pooh@gmail.com'],
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});

test('message validation succeeds with only `cc` recipient header (string)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		cc: 'pooh@gmail.com',
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});

test('message validation succeeds with only `cc` recipient header (array)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		cc: ['pooh@gmail.com'],
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});

test('message validation succeeds with only `bcc` recipient header (string)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		bcc: 'pooh@gmail.com',
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});

test('message validation succeeds with only `bcc` recipient header (array)', async (t) => {
	const { isValid, validationError } = new Message({
		from: 'piglet@gmail.com',
		bcc: ['pooh@gmail.com'],
	}).checkValidity();

	t.true(isValid);
	t.is(validationError, undefined);
});
