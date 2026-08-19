export interface WorkerProcessLike {
	stdin?: WritableStreamLike;
	stdout?: ReadableStreamLike;
	stderr?: ReadableStreamLike;
	on(event: "error", handler: (error: Error) => void): unknown;
	on(event: "exit", handler: (code: number | null, signal: string | null) => void): unknown;
	kill(signal?: string): boolean;
}

interface WritableStreamLike {
	write(data: string): boolean;
	end(): void;
}

interface ReadableStreamLike {
	on(event: "data", handler: (chunk: string | Uint8Array) => void): unknown;
	on(event: "error", handler: (error: Error) => void): unknown;
}

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

export interface RpcCommand {
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
}

export class RpcWorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcWorkerError";
	}
}

/**
 * Minimal JSONL request/response client for the Pi RPC protocol.
 *
 * Sends one JSON command per line to the worker's stdin and correlates
 * `type: "response"` lines by request id. All other lines are forwarded
 * to `onEvent` handlers as events.
 */
export class JsonlRpcClient {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventHandlers: Array<(event: Record<string, unknown>) => void> = [];
	private nextRequestId = 0;
	private inputBuffer = "";
	private closed = false;

	private readonly process: WorkerProcessLike;

	constructor(process: WorkerProcessLike) {
		this.process = process;
		if (!process.stdin || !process.stdout) throw new RpcWorkerError("RPC worker did not expose stdin/stdout");
		process.stdout.on("data", (chunk) => this.receive(chunk));
		process.stdout.on("error", (error) => this.fail(error));
		process.on("error", (error) => this.fail(error));
		process.on("exit", (code, signal) => {
			this.fail(new RpcWorkerError(`RPC worker exited before responding (code=${code}, signal=${signal})`));
		});
	}

	onEvent(handler: (event: Record<string, unknown>) => void): void {
		this.eventHandlers.push(handler);
	}

	request(command: RpcCommand): Promise<RpcResponse> {
		if (this.closed) return Promise.reject(new RpcWorkerError("RPC worker is closed"));
		const id = `delegate-${++this.nextRequestId}`;
		const request = { ...command, id };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.process.stdin!.write(`${JSON.stringify(request)}\n`);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.closed = true;
		this.fail(new RpcWorkerError("RPC worker closed"));
	}

	private receive(chunk: string | Uint8Array): void {
		this.inputBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		while (true) {
			const newline = this.inputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.inputBuffer.slice(0, newline).replace(/\r$/, "");
			this.inputBuffer = this.inputBuffer.slice(newline + 1);
			if (!line) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				this.eventHandlers.forEach((handler) => handler({ type: "malformed", line }));
				continue;
			}
			if (event.type === "response" && typeof event.id === "string") {
				const pending = this.pending.get(event.id);
				if (pending) {
					this.pending.delete(event.id);
					const response = event as unknown as RpcResponse;
					if (response.success) pending.resolve(response);
					else pending.reject(new RpcWorkerError(response.error ?? `RPC ${response.command} failed`));
					continue;
				}
			}
			this.eventHandlers.forEach((handler) => handler(event));
		}
	}

	private fail(error: Error): void {
		if (this.closed && this.pending.size === 0) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
