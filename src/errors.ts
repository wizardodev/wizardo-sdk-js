/**
 * Thrown by every SDK method when the API returns a non-2xx response.
 * Match on `code` for programmatic handling.
 *
 * @example
 * try {
 *   await client.deploy({ ... })
 * } catch (err) {
 *   if (err instanceof WizardoApiError && err.code === 'env_not_found') {
 *     console.error('create the environment in the Wizardo console first')
 *   }
 * }
 */
export class WizardoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(`[${code}] ${message}`)
    this.name = "WizardoApiError"
  }
}
