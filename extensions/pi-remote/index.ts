// PROTOTYPE: read-only, single-session mobile document stream for a running Pi TUI.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PublishedBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; id?: string; name: string; arguments: unknown }
	| { type: "image"; mimeType?: string };

type PublishedMessage = {
	id: string;
	role: string;
	timestamp?: number;
	content: PublishedBlock[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	provider?: string;
	model?: string;
	stopReason?: string;
};

type PublishedTool = {
	id: string;
	name: string;
	arguments: unknown;
	state: "running" | "done" | "error";
	output?: string;
};

type Snapshot = {
	prototype: true;
	connected: true;
	status: "idle" | "working";
	session: {
		id: string;
		name?: string;
		cwd: string;
		file?: string;
	};
	messages: PublishedMessage[];
	tools: PublishedTool[];
	updatedAt: number;
};

const HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Pi Remote Prototype</title>
<style>
:root{--bg:#f5f3ee;--paper:#fffefa;--ink:#20211f;--muted:#77776f;--line:#dedbd2;--accent:#486b57;--user:#e6ece7;--tool:#eeece5;--error:#a33d32;--code:#252925;--code-ink:#e8eee8}*{box-sizing:border-box}html{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;min-height:100vh}.top{position:sticky;top:0;z-index:4;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}.topline{max-width:760px;margin:auto;display:flex;gap:12px;align-items:center}.mark{width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:var(--ink);color:var(--paper);font:bold 15px ui-monospace,monospace}.identity{min-width:0;flex:1}.name{font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.presence{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}.dot{width:7px;height:7px;border-radius:50%;background:#91a096}.working .dot{background:#d4953a;box-shadow:0 0 0 4px color-mix(in srgb,#d4953a 18%,transparent)}main{max-width:760px;margin:0 auto;padding:22px 14px calc(80px + env(safe-area-inset-bottom))}.empty{padding:30vh 20px 0;text-align:center;color:var(--muted)}.message{margin:0 0 22px}.message.user{margin-left:auto;max-width:88%;padding:11px 13px;border-radius:16px 16px 5px 16px;background:var(--user);font-size:15px}.message.assistant{font-family:ui-serif,Georgia,"Noto Serif SC",serif;font-size:17px;line-height:1.72}.message.assistant .label{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.label{font-size:10px;line-height:1.2;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:7px}.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}.content p{margin:.6em 0}.content h1,.content h2,.content h3{line-height:1.25;margin:1.2em 0 .45em;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.content h1{font-size:1.42em}.content h2{font-size:1.23em}.content h3{font-size:1.08em}.content ul{padding-left:1.3em}.content blockquote{margin:.8em 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84em;background:var(--tool);padding:.1em .3em;border-radius:4px}pre{overflow:auto;margin:12px -2px;padding:13px;border-radius:10px;background:var(--code);color:var(--code-ink);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-overflow-scrolling:touch}pre code{padding:0;background:none;color:inherit}.tool,.thinking{margin:10px 0;border:1px solid var(--line);border-radius:10px;background:var(--tool);font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.tool summary,.thinking summary{padding:10px 12px;cursor:pointer;font-weight:600}.tool pre,.thinking pre{margin:0;border-radius:0 0 9px 9px;max-height:45vh}.tool.error{border-color:color-mix(in srgb,var(--error) 45%,var(--line))}.tool-result{margin:-10px 0 20px 18px}.live-tools{margin:4px 0 22px}.live-tools .tool{border-style:dashed}.banner{display:none;position:fixed;z-index:8;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:8px 12px;border-radius:99px;background:var(--ink);color:var(--paper);font-size:12px;box-shadow:0 5px 20px #0003}.banner.show{display:block}.gate{display:none;position:fixed;inset:0;z-index:20;background:var(--bg);padding:24vh 24px}.gate.show{display:block}.gate form{max-width:420px;margin:auto}.gate h1{font-size:23px}.gate p{color:var(--muted);line-height:1.55}.gate input{width:100%;font:16px ui-monospace,monospace;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--paper);color:var(--ink)}.gate button{width:100%;margin-top:10px;padding:12px;border:0;border-radius:9px;background:var(--ink);color:var(--paper);font-weight:650}@media(prefers-color-scheme:dark){:root{--bg:#171a18;--paper:#20231f;--ink:#ecece6;--muted:#9a9d95;--line:#363a35;--accent:#9fbea9;--user:#29342d;--tool:#242924;--code:#101310;--code-ink:#e0e8e1}}
</style>
</head>
<body>
<header class="top"><div class="topline"><div class="mark">π</div><div class="identity"><div class="name" id="name">Pi Remote Prototype</div><div class="meta" id="meta">等待会话...</div></div><div class="presence" id="presence"><span class="dot"></span><span>连接中</span></div></div></header>
<main id="stream"><div class="empty">正在连接 Pi 会话...</div></main>
<div class="banner" id="banner">连接中断，正在重连...</div>
<div class="gate" id="gate"><form id="gateForm"><h1>连接 Pi 会话</h1><p>输入 Pi TUI 启动时显示的临时访问 token。它只保存在这台设备的浏览器中。</p><input id="tokenInput" type="password" autocomplete="off" autocapitalize="off" placeholder="Access token"><button>连接</button></form></div>
<script>
const stream=document.querySelector('#stream'),banner=document.querySelector('#banner'),gate=document.querySelector('#gate');
let source,state,lastCount=0;
const query=new URLSearchParams(location.search);let token=query.get('token')||localStorage.getItem('pi-remote-token')||'';
if(query.has('token')){localStorage.setItem('pi-remote-token',token);history.replaceState(null,'',location.pathname)}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function inline(value){return value.replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>')}
function markdown(raw){let text=esc(raw),blocks=[];text=text.replace(/\x60\x60\x60([^\n]*)\n([\s\S]*?)\x60\x60\x60/g,(_,lang,code)=>{const key='@@CODE'+blocks.length+'@@';blocks.push('<pre><code>'+code.replace(/^\n|\n$/g,'')+'</code></pre>');return key});const lines=text.split('\n');let out='',list=false;for(const line of lines){const code=line.match(/^@@CODE(\d+)@@$/);if(code){if(list){out+='</ul>';list=false}out+=blocks[Number(code[1])];continue}const heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){if(list){out+='</ul>';list=false}const n=heading[1].length;out+='<h'+n+'>'+inline(heading[2])+'</h'+n+'>';continue}const item=line.match(/^[-*]\s+(.+)$/);if(item){if(!list){out+='<ul>';list=true}out+='<li>'+inline(item[1])+'</li>';continue}if(list){out+='</ul>';list=false}if(line.startsWith('&gt; ')){out+='<blockquote>'+inline(line.slice(5))+'</blockquote>'}else if(line.trim()){out+='<p>'+inline(line)+'</p>'}}if(list)out+='</ul>';return out}
function blockHtml(block){if(block.type==='text')return markdown(block.text);if(block.type==='thinking')return '<details class="thinking"><summary>思考过程</summary><pre>'+esc(block.text)+'</pre></details>';if(block.type==='toolCall')return '<details class="tool"><summary>'+esc(block.name)+' <span style="color:var(--muted);font-weight:400">tool call</span></summary><pre>'+esc(JSON.stringify(block.arguments,null,2))+'</pre></details>';return '<p style="color:var(--muted)">[图片内容暂未在 alpha 中显示]</p>'}
function messageHtml(message){const body=message.content.map(blockHtml).join('');if(message.role==='user')return '<article class="message user"><div class="label">你</div><div class="content">'+body+'</div></article>';if(message.role==='assistant')return '<article class="message assistant"><div class="label">Pi'+(message.model?' · '+esc(message.model):'')+'</div><div class="content">'+body+'</div></article>';if(message.role==='toolResult')return '<details class="tool tool-result '+(message.isError?'error':'')+'"><summary>'+esc(message.toolName||'tool')+(message.isError?' · fail':' · ok')+'</summary><pre>'+esc(message.content.map(b=>b.type==='text'?b.text:'['+b.type+']').join('\n'))+'</pre></details>';return '<article class="message"><div class="label">'+esc(message.role)+'</div><div class="content">'+body+'</div></article>'}
function render(next){const nearBottom=innerHeight+scrollY>=document.body.scrollHeight-180;state=next;document.querySelector('#name').textContent=next.session.name||'Pi Session';document.querySelector('#meta').textContent=next.session.cwd;const presence=document.querySelector('#presence');presence.className='presence '+next.status;presence.lastElementChild.textContent=next.status==='working'?'运行中':'空闲';let html=next.messages.map(messageHtml).join('');if(next.tools.length){html+='<section class="live-tools"><div class="label">正在执行</div>'+next.tools.map(t=>'<details class="tool '+(t.state==='error'?'error':'')+'" open><summary>'+esc(t.name)+' · '+(t.state==='running'?'running':t.state)+'</summary><pre>'+esc(t.output||JSON.stringify(t.arguments,null,2))+'</pre></details>').join('')+'</section>'}stream.innerHTML=html||'<div class="empty">这个会话还没有消息。</div>';if(nearBottom||next.messages.length>lastCount){requestAnimationFrame(()=>scrollTo({top:document.body.scrollHeight,behavior:lastCount?'smooth':'auto'}))}lastCount=next.messages.length}
function connect(){if(!token){gate.classList.add('show');return}gate.classList.remove('show');source?.close();source=new EventSource('/events?token='+encodeURIComponent(token));source.addEventListener('snapshot',event=>{banner.classList.remove('show');render(JSON.parse(event.data))});source.onopen=()=>banner.classList.remove('show');source.onerror=()=>banner.classList.add('show')}
document.querySelector('#gateForm').addEventListener('submit',event=>{event.preventDefault();token=document.querySelector('#tokenInput').value.trim();if(token){localStorage.setItem('pi-remote-token',token);connect()}});connect();
</script>
</body>
</html>`;

function normalizeContent(content: unknown): PublishedBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];

	return content.flatMap((block): PublishedBlock[] => {
		if (!block || typeof block !== "object") return [];
		const value = block as Record<string, unknown>;
		if (value.type === "text") return [{ type: "text", text: String(value.text ?? "") }];
		if (value.type === "thinking") return [{ type: "thinking", text: String(value.thinking ?? "") }];
		if (value.type === "toolCall") {
			return [{
				type: "toolCall",
				id: typeof value.id === "string" ? value.id : undefined,
				name: String(value.name ?? "tool"),
				arguments: value.arguments ?? {},
			}];
		}
		if (value.type === "image") {
			return [{ type: "image", mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined }];
		}
		return [];
	});
}

function normalizeMessage(message: unknown, id: string): PublishedMessage {
	const value = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
	return {
		id,
		role: String(value.role ?? "unknown"),
		timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
		content: normalizeContent(value.content),
		toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		toolName: typeof value.toolName === "string" ? value.toolName : undefined,
		isError: typeof value.isError === "boolean" ? value.isError : undefined,
		provider: typeof value.provider === "string" ? value.provider : undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
	};
}

function textFromToolResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
		.map((block) => String((block as Record<string, unknown>).text ?? ""))
		.join("\n");
}

export default function piRemotePrototype(pi: ExtensionAPI) {
	const enabledAtStartup = /^(1|true|yes)$/i.test(process.env.PI_REMOTE_ENABLED?.trim() || "");
	const defaultHost = process.env.PI_REMOTE_HOST?.trim() || "127.0.0.1";
	const defaultPort = Number.parseInt(process.env.PI_REMOTE_PORT || "8787", 10);
	const processState = globalThis as typeof globalThis & { __pimonoPiRemoteToken?: string };
	const token = process.env.PI_REMOTE_TOKEN?.trim()
		|| (processState.__pimonoPiRemoteToken ??= randomBytes(18).toString("base64url"));
	const defaultPublicUrl = process.env.PI_REMOTE_PUBLIC_URL?.trim();
	let server: Server | undefined;
	let accessUrl: string | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
	let clients = new Set<ServerResponse>();
	let messages: PublishedMessage[] = [];
	let tools = new Map<string, PublishedTool>();
	let status: Snapshot["status"] = "idle";
	let session = { id: "", name: undefined as string | undefined, cwd: "", file: undefined as string | undefined };
	let liveMessageId: string | undefined;
	let serial = 0;

	const snapshot = (): Snapshot => ({
		prototype: true,
		connected: true,
		status,
		session,
		messages,
		tools: [...tools.values()],
		updatedAt: Date.now(),
	});

	const sendSnapshot = () => {
		broadcastTimer = undefined;
		const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
		for (const client of clients) client.write(frame);
	};

	const broadcast = (immediate = false) => {
		if (broadcastTimer) clearTimeout(broadcastTimer);
		if (immediate) sendSnapshot();
		else broadcastTimer = setTimeout(sendSnapshot, 80);
	};

	const authorized = (request: IncomingMessage) => {
		const url = new URL(request.url || "/", "http://localhost");
		const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
		return url.searchParams.get("token") === token || bearer === token;
	};

	const hydrateSession = (ctx: ExtensionContext) => {
		serial = 0;
		liveMessageId = undefined;
		tools = new Map();
		status = "idle";
		session = {
			id: ctx.sessionManager.getSessionId(),
			name: pi.getSessionName(),
			cwd: ctx.cwd,
			file: ctx.sessionManager.getSessionFile(),
		};
		messages = ctx.sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "message") return [];
			return [normalizeMessage(entry.message, entry.id)];
		});
	};

	const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url || "/", "http://localhost");
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");

		if (request.method === "GET" && url.pathname === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(HTML);
			return;
		}
		if (request.method === "GET" && url.pathname === "/health") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end('{"ok":true,"prototype":true}');
			return;
		}
		if (!authorized(request)) {
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end('{"error":"unauthorized"}');
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/snapshot") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(snapshot()));
			return;
		}
		if (request.method === "GET" && url.pathname === "/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}
		response.writeHead(404, { "Content-Type": "application/json" });
		response.end('{"error":"not_found"}');
	};

	type StartOptions = { host?: string; port?: number; publicUrl?: string };

	const parseStartOptions = (args: string): StartOptions => {
		const parts = args.trim() ? args.trim().split(/\s+/) : [];
		const options: StartOptions = {};
		for (let index = 0; index < parts.length; index++) {
			const [flag, inlineValue] = parts[index].split("=", 2);
			const value = inlineValue ?? parts[++index];
			if (!value) throw new Error(`Missing value for ${flag}`);
			if (flag === "--host") options.host = value;
			else if (flag === "--port") options.port = Number.parseInt(value, 10);
			else if (flag === "--public-url") options.publicUrl = value;
			else throw new Error(`Unknown option: ${flag}`);
		}
		if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
			throw new Error("--port must be an integer between 0 and 65535");
		}
		return options;
	};

	const announceUrl = (ctx: ExtensionContext) => {
		if (!accessUrl) {
			ctx.ui.notify("Pi Remote Prototype is not running", "warning");
			return;
		}
		ctx.ui.notify(`Pi Remote Prototype: ${accessUrl}`, "info");
	};

	const startServer = async (ctx: ExtensionContext, options: StartOptions = {}) => {
		if (server) {
			announceUrl(ctx);
			return;
		}
		const host = options.host || defaultHost;
		const requestedPort = options.port ?? defaultPort;
		const publicUrl = options.publicUrl || defaultPublicUrl;
		server = createServer(requestHandler);
		server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
		try {
			await new Promise<void>((resolve, reject) => {
				server!.once("error", reject);
				server!.listen(requestedPort, host, () => {
					server!.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			server = undefined;
			throw error;
		}
		const address = server.address() as AddressInfo;
		const localUrl = `http://${host === "0.0.0.0" ? "localhost" : host}:${address.port}/`;
		const shownUrl = publicUrl || localUrl;
		const separator = shownUrl.includes("?") ? "&" : "?";
		accessUrl = `${shownUrl}${separator}token=${token}`;
		ctx.ui.setStatus("pi-remote-prototype", `remote: ${address.port}`);
		announceUrl(ctx);
		heartbeat = setInterval(() => {
			for (const client of clients) client.write(": heartbeat\n\n");
		}, 15_000);
	};

	const stopServer = async (ctx?: ExtensionContext) => {
		if (broadcastTimer) clearTimeout(broadcastTimer);
		broadcastTimer = undefined;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		for (const client of clients) client.end();
		clients = new Set();
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
		accessUrl = undefined;
		ctx?.ui.setStatus("pi-remote-prototype", undefined);
	};

	pi.registerCommand("pi-remote-start", {
		description: "Start the read-only Pi Remote web prototype",
		handler: async (args, ctx) => startServer(ctx, parseStartOptions(args)),
	});

	pi.registerCommand("pi-remote-stop", {
		description: "Stop the Pi Remote web prototype",
		handler: async (_args, ctx) => stopServer(ctx),
	});

	pi.registerCommand("pi-remote-url", {
		description: "Show the current Pi Remote prototype URL",
		handler: async (_args, ctx) => announceUrl(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		hydrateSession(ctx);
		if (enabledAtStartup) await startServer(ctx);
	});

	pi.on("session_info_changed", (event) => {
		session = { ...session, name: event.name };
		broadcast(true);
	});

	pi.on("session_tree", (_event, ctx) => {
		hydrateSession(ctx);
		broadcast(true);
	});

	pi.on("agent_start", () => {
		status = "working";
		broadcast(true);
	});

	pi.on("agent_settled", () => {
		status = "idle";
		broadcast(true);
	});

	pi.on("message_start", (event) => {
		liveMessageId = `live-${++serial}`;
		messages = [...messages, normalizeMessage(event.message, liveMessageId)];
		broadcast(true);
	});

	pi.on("message_update", (event) => {
		if (!liveMessageId) {
			liveMessageId = `live-${++serial}`;
			messages = [...messages, normalizeMessage(event.message, liveMessageId)];
		} else {
			messages = messages.map((message) =>
				message.id === liveMessageId ? normalizeMessage(event.message, liveMessageId!) : message,
			);
		}
		broadcast();
	});

	pi.on("message_end", (event) => {
		if (liveMessageId) {
			messages = messages.map((message) =>
				message.id === liveMessageId ? normalizeMessage(event.message, liveMessageId!) : message,
			);
		} else {
			messages = [...messages, normalizeMessage(event.message, `live-${++serial}`)];
		}
		liveMessageId = undefined;
		const ended = normalizeMessage(event.message, "ended");
		if (ended.toolCallId) tools.delete(ended.toolCallId);
		broadcast(true);
	});

	pi.on("tool_execution_start", (event) => {
		tools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			arguments: event.args,
			state: "running",
		});
		broadcast(true);
	});

	pi.on("tool_execution_update", (event) => {
		const current = tools.get(event.toolCallId);
		tools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			arguments: event.args,
			state: "running",
			output: textFromToolResult(event.partialResult) ?? current?.output,
		});
		broadcast();
	});

	pi.on("tool_execution_end", (event) => {
		const current = tools.get(event.toolCallId);
		tools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			arguments: current?.arguments ?? {},
			state: event.isError ? "error" : "done",
			output: textFromToolResult(event.result),
		});
		broadcast(true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopServer(ctx);
	});
}
