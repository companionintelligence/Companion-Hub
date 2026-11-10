/**
 * For a port field's `setValueAs`. A whole number typed here becomes a number, so the schema's range check and
 * translated messages apply. Anything else, such as an env reference or a range, stays as typed.
 */
export const plainPortAsNumber = (value: unknown) => (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value);
