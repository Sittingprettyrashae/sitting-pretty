// Sitting Pretty demo server: notification templates.
// Each event renders to an email {subject, body} and an sms {body}.
// Tone: warm and brief, signed "Sitting Pretty". No em dashes. No invented policies.

const PHONE = '(817) 704-8300';

function niceDate(dateStr) {
  const d = new Date(String(dateStr) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function niceTime(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!m) return String(timeStr);
  let h = Number(m[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m[2] + ' ' + ap;
}

function money(cents) {
  if (cents == null) return '';
  return cents % 100 === 0 ? '$' + cents / 100 : '$' + (cents / 100).toFixed(2);
}

function when(b) {
  return niceDate(b.date) + ' at ' + niceTime(b.time);
}

function summary(b) {
  const lines = [b.service_name, when(b), 'Price: ' + b.price];
  if (b.deposit_cents != null) lines.push('Deposit: ' + money(b.deposit_cents));
  return lines.join('\n');
}

// renderNotification(event, data) -> { email: {subject, body} | null, sms: {body} | null }
// data: { booking?, name?, code?, checkout_url?, subject?, message?, client_email? }
export function renderNotification(event, data) {
  const d = data || {};
  const b = d.booking || {};
  const name = (d.name || b.client_name || 'there').split(' ')[0];

  switch (event) {
    case 'login_code':
      return {
        email: {
          subject: 'Your Sitting Pretty sign-in code',
          body:
            'Hi ' + name + ',\n\n' +
            'Your sign-in code is ' + d.code + '. It expires in 10 minutes.\n\n' +
            'If you did not request this, you can ignore this message.\n\n' +
            'Sitting Pretty'
        },
        sms: { body: 'Sitting Pretty: your sign-in code is ' + d.code + '. It expires in 10 minutes.' }
      };

    case 'booking_created_awaiting_deposit':
      return {
        email: {
          subject: 'Hold your spot: ' + b.service_name + ' on ' + niceDate(b.date),
          body:
            'Hi ' + name + ',\n\n' +
            'Your appointment is almost set:\n\n' +
            summary(b) + '\n\n' +
            'Pay your deposit here to lock it in:\n' +
            d.checkout_url + '\n\n' +
            'The deposit is due within 24 hours or the appointment is cancelled. ' +
            'It comes off your balance the day of your service.\n\n' +
            'See you soon,\nSitting Pretty\n' + PHONE
        },
        sms: {
          body:
            'Sitting Pretty: your ' + b.service_name + ' on ' + when(b) +
            ' is held. Pay your ' + money(b.deposit_cents) +
            ' deposit within 24 hours to lock it in: ' + d.checkout_url
        }
      };

    case 'booking_request_received':
      return {
        email: {
          subject: 'We got your request: ' + b.service_name,
          body:
            'Hi ' + name + ',\n\n' +
            'Thanks for your booking request:\n\n' +
            summary(b) + '\n\n' +
            'Ebony will confirm your appointment shortly. ' +
            'Text ' + PHONE + ' if anything changes.\n\n' +
            'Sitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: we got your request for ' + b.service_name +
            ' on ' + when(b) + '. Ebony will confirm shortly.'
        }
      };

    case 'booking_confirmed':
      return {
        email: {
          subject: 'You are booked: ' + b.service_name + ' on ' + niceDate(b.date),
          body:
            'Hi ' + name + ',\n\n' +
            'You are all set:\n\n' +
            summary(b) + '\n\n' +
            'Text ' + PHONE + ' if you need anything before your visit.\n\n' +
            'See you soon,\nSitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: you are booked. ' + b.service_name + ' on ' + when(b) + '. See you soon.'
        }
      };

    case 'booking_canceled_by_client':
      return {
        email: {
          subject: 'Your appointment is cancelled',
          body:
            'Hi ' + name + ',\n\n' +
            'Your ' + b.service_name + ' on ' + when(b) + ' has been cancelled as requested.\n\n' +
            'Whenever you are ready to rebook, we would love to see you again.\n\n' +
            'Sitting Pretty\n' + PHONE
        },
        sms: {
          body:
            'Sitting Pretty: your ' + b.service_name + ' on ' + when(b) +
            ' is cancelled. Book again anytime.'
        }
      };

    case 'booking_canceled_admin_copy':
      return {
        email: {
          subject: 'Client cancellation: ' + (b.client_name || d.client_email || 'a client') + ' on ' + niceDate(b.date),
          body:
            (b.client_name || 'A client') + ' (' + (b.client_email || 'no email') + ') cancelled:\n\n' +
            summary(b) + '\n\n' +
            'The slot is open again.\n\n' +
            'Sitting Pretty demo server'
        },
        sms: null
      };

    case 'booking_canceled_deposit_unpaid':
      return {
        email: {
          subject: 'Your appointment was cancelled',
          body:
            'Hi ' + name + ',\n\n' +
            'Your ' + b.service_name + ' on ' + when(b) +
            ' has been cancelled because the deposit was not paid within 24 hours of booking.\n\n' +
            'A deposit is required to secure every appointment. ' +
            'You are welcome to book again anytime, and you can text ' + PHONE + ' with any questions.\n\n' +
            'Sitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: your ' + b.service_name + ' on ' + when(b) +
            ' was cancelled because the deposit was not paid within 24 hours. Book again anytime.'
        }
      };

    case 'booking_canceled_by_admin':
      return {
        email: {
          subject: 'About your appointment on ' + niceDate(b.date),
          body:
            'Hi ' + name + ',\n\n' +
            'We are sorry, your ' + b.service_name + ' on ' + when(b) + ' has been cancelled.\n\n' +
            'Text ' + PHONE + ' and we will find a new time that works for you.\n\n' +
            'Sitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: your ' + b.service_name + ' on ' + when(b) +
            ' was cancelled. Text ' + PHONE + ' to rebook.'
        }
      };

    case 'broadcast':
      return {
        email: {
          subject: d.subject || 'A note from Sitting Pretty',
          body:
            'Hi ' + name + ',\n\n' +
            d.message + '\n\n' +
            'Sitting Pretty\n' + PHONE
        },
        sms: { body: 'Sitting Pretty: ' + d.message }
      };

    default:
      return {
        email: { subject: 'Sitting Pretty', body: String(d.message || '') },
        sms: null
      };
  }
}
