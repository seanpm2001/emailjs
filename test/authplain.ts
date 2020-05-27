import type { Readable } from 'stream';
import test from 'ava';
import mailparser from 'mailparser';
import smtp from 'smtp-server';

import { client as c, message as m } from '../email';

type UnPromisify<T> = T extends Promise<infer U> ? U : T;

const port = 2526;
const client = new c.Client({
	port,
	user: 'pooh',
	password: 'honey',
	ssl: true,
});
const server = new smtp.SMTPServer({ secure: true, authMethods: ['LOGIN'] });

const send = (
	message: m.Message,
	verify: (
		mail: UnPromisify<ReturnType<typeof mailparser.simpleParser>>
	) => void,
	done: () => void
) => {
	server.onData = (stream: Readable, _session, callback: () => void) => {
		mailparser.simpleParser(stream).then(verify).then(done).catch(done);
		stream.on('end', callback);
	};
	client.send(message, (err) => {
		if (err) {
			throw err;
		}
	});
};

test.before.cb((t) => {
	server.listen(port, function () {
		server.onAuth = function (auth, _session, callback) {
			if (auth.username == 'pooh' && auth.password == 'honey') {
				callback(null, { user: 'pooh' });
			} else {
				return callback(new Error('invalid user / pass'));
			}
		};
		t.end();
	});
});

test.after.cb((t) => server.close(t.end));

test.cb('authorize plain', (t) => {
	const msg = {
		subject: 'this is a test TEXT message from emailjs',
		from: 'piglet@gmail.com',
		to: 'pooh@gmail.com',
		text: "It is hard to be brave when you're only a Very Small Animal.",
	};

	send(
		new m.Message(msg),
		(mail) => {
			t.is(mail.text, msg.text + '\n\n\n');
			t.is(mail.subject, msg.subject);
			t.is(mail.from?.text, msg.from);
			t.is(mail.to?.text, msg.to);
		},
		t.end
	);
});

test.cb(
	'Client refuses to send message without `to`, `cc`, or `bcc` header',
	(t) => {
		const msg = {
			subject: 'this is a test TEXT message from emailjs',
			from: 'piglet@gmail.com',
			text: "It is hard to be brave when you're only a Very Small Animal.",
		};
		client.send(new m.Message(msg), (err) => {
			t.true(err instanceof Error);
			t.is(
				err?.message,
				'Message must have at least one `to`, `cc`, or `bcc` header'
			);
			t.end();
		});
	}
);

test.cb('Client allows message with only `cc` header', (t) => {
	const msg = {
		subject: 'this is a test TEXT message from emailjs',
		from: 'piglet@gmail.com',
		cc: 'pooh@gmail.com',
		text: "It is hard to be brave when you're only a Very Small Animal.",
	};

	send(
		new m.Message(msg),
		(mail) => {
			t.is(mail.text, msg.text + '\n\n\n');
			t.is(mail.subject, msg.subject);
			t.is(mail.from?.text, msg.from);
			t.is(mail.cc?.text, msg.cc);
		},
		t.end
	);
});

test.cb('Client allows message with only `bcc` header', (t) => {
	const msg = {
		subject: 'this is a test TEXT message from emailjs',
		from: 'piglet@gmail.com',
		bcc: 'pooh@gmail.com',
		text: "It is hard to be brave when you're only a Very Small Animal.",
	};

	send(
		new m.Message(msg),
		(mail) => {
			t.is(mail.text, msg.text + '\n\n\n');
			t.is(mail.subject, msg.subject);
			t.is(mail.from?.text, msg.from);
			t.is(mail.bcc?.text, undefined);
		},
		t.end
	);
});

test('Client constructor throws if `password` supplied without `user`', (t) => {
	t.notThrows(() => new c.Client({ user: 'anything', password: 'anything' }));
	t.throws(() => new c.Client({ password: 'anything' }));
	t.throws(
		() =>
			new c.Client({ username: 'anything', password: 'anything' } as Record<
				string,
				unknown
			>)
	);
});
