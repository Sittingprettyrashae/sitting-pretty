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

    case 'reset_code':
      return {
        email: {
          subject: 'Reset your Sitting Pretty password',
          body:
            'Hi ' + name + ',\n\n' +
            'Your reset code is ' + d.code + '. It expires in 10 minutes.\n\n' +
            'Enter it on the sign-in screen and you can set a new password right after.\n\n' +
            'If you did not ask to reset your password, you can ignore this message ' +
            'and your current one keeps working.\n\n' +
            'Sitting Pretty'
        },
        sms: {
          body: 'Sitting Pretty: your password reset code is ' + d.code +
            '. It expires in 10 minutes.'
        }
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

    case 'booking_confirmed': {
      // Deposit is in, so the time is hers and nobody else can take it. Say
      // plainly what is still owed and that either way of paying is fine.
      const bal = d.balance_cents;
      const restLine = bal
        ? 'Your deposit is paid and this time is now held for you.\n' +
          'Balance still due: ' + money(bal) + '. Bring it to your appointment, ' +
          'or sign in any time and pay it online before you come.\n\n'
        : 'Your deposit is paid and this time is now held for you.\n' +
          'Ebony will settle the rest with you at your appointment.\n\n';
      return {
        email: {
          subject: 'You are booked: ' + b.service_name + ' on ' + niceDate(b.date),
          body:
            'Hi ' + name + ',\n\n' +
            'You are all set:\n\n' +
            summary(b) + '\n\n' +
            restLine +
            'Text ' + PHONE + ' if you need anything before your visit.\n\n' +
            'See you soon,\nSitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: you are booked. ' + b.service_name + ' on ' + when(b) +
            '. Your time is held.' + (bal ? ' Balance ' + money(bal) + ' due at your appointment or online.' : '')
        }
      };
    }

    case 'balance_paid':
      return {
        email: {
          subject: 'Paid in full: ' + b.service_name + ' on ' + niceDate(b.date),
          body:
            'Hi ' + name + ',\n\n' +
            'Your ' + b.service_name + ' on ' + when(b) + ' is now paid in full. ' +
            'Nothing to bring but yourself.\n\n' +
            'See you soon,\nSitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: ' + b.service_name + ' on ' + when(b) +
            ' is paid in full. Nothing due at your appointment.'
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

    case 'payment_needs_refund':
      return {
        email: {
          subject: 'Refund needed: payment received for a cancelled appointment',
          body:
            'Heads up,\n\n' +
            'A payment came through for an appointment that was already off the books:\n\n' +
            b.service_name + '\n' + when(b) + '\n' +
            'Client: ' + (b.client_name || b.client_email) + ' (' + b.client_email + ')\n' +
            'Status: ' + b.status + '\n\n' +
            'Refund this one in your Stripe dashboard and let the client know.\n\n' +
            'Sitting Pretty'
        },
        sms: {
          body:
            'Sitting Pretty: payment received for a cancelled appointment (' +
            (b.client_name || b.client_email) + ', ' + when(b) + '). Refund it in Stripe.'
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
