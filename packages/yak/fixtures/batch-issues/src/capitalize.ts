/** Capitalizes the first letter of a string, leaves the rest untouched. */
export function capitalize(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
