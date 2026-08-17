/**
 * Agent↔agent mailbox. Pure logic, no pi imports — easily unit-tested.
 * Agents talk by polling, not push: send() enqueues, poll() drains.
 */

export interface MailboxMessage {
	from: string;
	text: string;
	at: number;
}

export interface Mailbox {
	open(taskId: string): void;
	/** Returns false when sender or target is unknown (no silent drops). */
	send(from: string, to: string, text: string): boolean;
	/** Return and clear all pending messages for taskId. */
	poll(taskId: string): MailboxMessage[];
	close(taskId: string): void;
}

export function createMailbox(): Mailbox {
	const boxes = new Map<string, MailboxMessage[]>();
	return {
		open(taskId: string): void {
			if (!boxes.has(taskId)) boxes.set(taskId, []);
		},
		send(from: string, to: string, text: string): boolean {
			const box = boxes.get(to);
			if (!box || !boxes.has(from)) return false;
			box.push({ from, text, at: Date.now() });
			return true;
		},
		poll(taskId: string): MailboxMessage[] {
			const box = boxes.get(taskId);
			if (!box) return [];
			return box.splice(0);
		},
		close(taskId: string): void {
			boxes.delete(taskId);
		},
	};
}
