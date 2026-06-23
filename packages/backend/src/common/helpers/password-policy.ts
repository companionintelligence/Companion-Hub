export const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

export function meetsPasswordComplexity(password: string): boolean {
  return PASSWORD_COMPLEXITY_REGEX.test(password);
}
