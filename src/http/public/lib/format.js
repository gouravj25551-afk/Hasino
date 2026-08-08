/** Rupees, dates, distance — money is paise everywhere on the backend, formatted only here. */

export function rupees(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN');
}

export function time(iso, timezone) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

export function dateLong(iso, timezone) {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function distance(km) {
  if (km == null) return null;
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

export function statusLabel(status) {
  return status.replace(/_/g, ' ');
}
