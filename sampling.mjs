export const DEFAULT_SAMPLING_SECONDS = 2;

export function isSamplingInterval(seconds) {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60;
}
