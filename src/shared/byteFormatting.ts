/**
 * macOS is not consistent about what "GB" means, and the UI has to match what
 * the user can check elsewhere: About This Mac calls 25769803776 bytes of RAM
 * "24 GB" (binary), while Finder and System Settings > Storage call 494383795648
 * bytes of disk "494 GB" (decimal). So each figure is printed in the unit its
 * own source uses:
 *
 * - memory, and the model catalog's own `*Gb` fields: binary
 * - disk capacity and free space: decimal
 *
 * These live in `shared` because both processes print the same byte counts and
 * a figure must not read two different ways in one window.
 */
const BYTES_PER_BINARY_GB = 1_073_741_824;
const BYTES_PER_DECIMAL_GB = 1_000_000_000;
const BYTES_PER_DECIMAL_MB = 1_000_000;

/** One decimal below 10 GB so small figures read naturally, none above. */
function formatGB(bytes: number, bytesPerGB: number): string {
  const gigabytes = bytes / bytesPerGB;
  return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB`;
}

/** GiB, printed as "GB": installed memory, and catalog figures parsed as GB. */
export function formatBinaryGB(bytes: number): string {
  return formatGB(bytes, BYTES_PER_BINARY_GB);
}

/** Powers of 1000: disk capacity and free space, as Finder reports them. */
export function formatDecimalGB(bytes: number): string {
  return formatGB(bytes, BYTES_PER_DECIMAL_GB);
}

/**
 * A downloadable file's size, in the same decimal unit as the free space it
 * gets compared against. Both figures sit on the Add Model card and the user
 * reads one against the other, so they cannot use different divisors: a 197 GiB
 * model beside "207 GB free" looks like it fits when it does not.
 *
 * Drops to MB below a gigabyte, because a catalog full of small embedding and
 * reranker artifacts otherwise reads "0.0 GB" for every one of them.
 */
export function formatFileSize(bytes: number): string {
  return bytes < BYTES_PER_DECIMAL_GB
    ? `${Math.max(1, Math.round(bytes / BYTES_PER_DECIMAL_MB))} MB`
    : formatDecimalGB(bytes);
}
