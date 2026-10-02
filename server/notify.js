// Notification outbox. notify() queues one row per channel; deliverDue() sends whatever is due.
// In-app messages go to the inbox and the user's live stream. Email and WhatsApp go through adapters; the MVP's
// adapters log to the console until a provider (SMTP/SES, WhatsApp Business API) is configured.
import { all, id, now, one, run } from './db.js';
import { publishUser } from './events.js';

const adapters = {
  email: (user, n) => console.log(`[email] to=${user.email} subject="${n.title}" ${n.body}`),
  whatsapp: (user, n) => console.log(`[whatsapp] to=${user.phone} ${n.title}: ${n.body}`),
};
export const setAdapter = (channel, fn) => { adapters[channel] = fn; };

export function notify(userId, { kind, title, body, link = '', bookingId = null, sendAfter = Date.now(), channels = ['inapp', 'email', 'whatsapp'] }) {
  if (!userId) return;
  const user = one('SELECT email, phone FROM users WHERE id=?', userId);
  if (!user) return;
  for (const channel of channels) {
    if (channel === 'email' && !user.email) continue;
    if (channel === 'whatsapp' && !user.phone) continue;
    run('INSERT INTO notifications (id,user_id,channel,kind,title,body,link,booking_id,send_after,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id(), userId, channel, kind, title, body, link, bookingId, sendAfter, now());
  }
}

// Called when a booking is cancelled or moved so stale reminders never go out.
export const cancelPending = (bookingId, kind) => run("UPDATE notifications SET status='cancelled' WHERE booking_id=? AND kind=? AND status='queued'", bookingId, kind);

export function deliverDue() {
  const due = all("SELECT n.*, u.email, u.phone FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.status='queued' AND n.send_after<=? ORDER BY n.send_after LIMIT 200", Date.now());
  for (const n of due) {
    try {
      if (n.channel === 'inapp') publishUser(n.user_id, 'notification', { id: n.id, title: n.title, body: n.body, link: n.link, kind: n.kind });
      else if (adapters[n.channel]) adapters[n.channel](n, n);
      run("UPDATE notifications SET status='sent', sent_at=? WHERE id=?", now(), n.id);
    } catch (e) {
      console.error(`Notification ${n.id} failed:`, e.message);
      run("UPDATE notifications SET status='skipped', sent_at=? WHERE id=?", now(), n.id);
    }
  }
  return due.length;
}
