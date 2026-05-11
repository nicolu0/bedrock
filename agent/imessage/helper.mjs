// Bridge to the MessagesHelper.dylib injected into Messages.app.
//
// Architecture: WE listen on TCP localhost; the helper inside Messages.app
// connects out (sandboxed Messages.app cannot bind/listen, but its
// network.client entitlement allows outbound connect). Once connected we
// stream newline-delimited JSON requests with monotonic ids.
//
// Public API: helper.ping / markRead / setTyping / react / send.
// Each call resolves to {ok, ...} or {ok:false, error:...}. Never throws.

import net from 'node:net';

export const HELPER_PORT = 9772;

let helperSocket = null;
let buf = '';
let nextId = 1;
const pending = new Map(); // id -> { resolve, timer }
let serverStarted = false;
let connectedOnce = false;

function startServer() {
	if (serverStarted) return;
	serverStarted = true;

	const server = net.createServer((sock) => {
		// Only one helper at a time (Messages.app is a singleton). If a stale
		// connection lingers, drop it.
		if (helperSocket && !helperSocket.destroyed) {
			helperSocket.destroy();
		}
		helperSocket = sock;
		buf = '';
		connectedOnce = true;
		console.log('[helper] Messages.app helper connected');

		sock.on('data', (chunk) => {
			buf += chunk.toString('utf8');
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				const p = pending.get(msg.id);
				if (!p) continue;
				clearTimeout(p.timer);
				pending.delete(msg.id);
				p.resolve(msg);
			}
		});

		sock.on('close', () => {
			if (helperSocket === sock) helperSocket = null;
			// Reject any in-flight requests so callers don't hang.
			for (const [id, p] of pending) {
				clearTimeout(p.timer);
				p.resolve({ ok: false, error: 'helper disconnected' });
				pending.delete(id);
			}
			console.log('[helper] Messages.app helper disconnected');
		});

		sock.on('error', () => {});
	});

	server.on('error', (err) => {
		console.log(`[helper] server error: ${err.message}`);
	});

	server.listen(HELPER_PORT, '127.0.0.1', () => {
		console.log(`[helper] listening on 127.0.0.1:${HELPER_PORT} — waiting for Messages.app helper`);
	});
}

function call(payload, timeoutMs = 1500) {
	startServer();
	return new Promise((resolve) => {
		if (!helperSocket || helperSocket.destroyed) {
			return resolve({ ok: false, error: connectedOnce ? 'helper not connected' : 'helper not yet connected' });
		}
		const id = nextId++;
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ ok: false, error: 'timeout' });
		}, timeoutMs);
		pending.set(id, { resolve, timer });
		try {
			helperSocket.write(JSON.stringify({ id, ...payload }) + '\n');
		} catch (err) {
			pending.delete(id);
			clearTimeout(timer);
			resolve({ ok: false, error: err.message });
		}
	});
}

export const helper = {
	port: HELPER_PORT,
	isConnected: () => !!(helperSocket && !helperSocket.destroyed),
	ping: () => call({ op: 'ping' }),
	markRead: (chatGuid) => call({ op: 'markRead', chatGuid }),
	setTyping: (chatGuid, typing) => call({ op: 'setTyping', chatGuid, typing: !!typing }),
	// React to a message with a tapback. reactionType is one of:
	//   love, like, dislike, laugh, emphasize, question
	// Prefix with `-` to remove (e.g. `-love`). summaryText is the original
	// message text — used to render the fallback "Loved 'Hello'" string for
	// recipients on devices that don't render tapbacks natively.
	react: (chatGuid, messageGuid, reactionType, summaryText) =>
		call({ op: 'react', chatGuid, messageGuid, reactionType, summaryText: summaryText ?? '' }),
	send: (chatGuid, text) => call({ op: 'send', chatGuid, text }),
};

// Auto-start the listener on import — callers don't need to do anything.
startServer();
