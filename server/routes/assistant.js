// Instant-answer assistant. Works for signed-in and signed-out visitors; personal answers (bookings, refunds, orders) need sign-in.
import { rateLimit } from '../security.js';
import { respond } from '../assistant.js';
import { str } from '../validate.js';

export default function assistantRoutes(r) {
  r.post('/assistant/message', ({ u, body, req }) => {
    rateLimit(`bot:${u?.id || req.socket.remoteAddress}`, 40, 60 * 1000);
    return respond(str(body.text, 'Message', { max: 300, optional: true }), u || null);
  }, { auth: 'optional' });
}
