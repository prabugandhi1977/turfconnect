// Server-sent events. Browsers subscribe to a venue (live availability, no sign-in needed) and/or to their own
// user channel (booking status, notifications). Payloads carry no private data for venue channels.
const clients = new Set();

export function subscribe(req, res, { venueId = null, userId = null }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const client = { res, venueId, userId };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}

function send(filter, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (filter(c)) c.res.write(msg);
}
export const publishVenue = (venueId, data) => send(c => c.venueId === venueId, 'availability', { venueId, ...data });
export const publishUser = (userId, event, data) => send(c => c.userId === userId, event, data);
export const clientCount = () => clients.size;
