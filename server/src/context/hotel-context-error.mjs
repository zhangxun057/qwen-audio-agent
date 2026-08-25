export class HotelContextError extends Error {
  constructor(message, {
    code = 'HOTEL_CONTEXT_ERROR',
    status = 500,
    cause,
  } = {}) {
    super(message, { cause })
    this.name = 'HotelContextError'
    this.code = code
    this.status = status
  }
}
