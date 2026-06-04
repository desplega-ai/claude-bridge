export type PrintErrorResultOptions = {
  sessionId?: string;
  debug?: Record<string, unknown>[];
  rawResponse?: string;
};

export function makePrintErrorResult(
  message: string,
  options: PrintErrorResultOptions = {}
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    error: message,
    ...(options.rawResponse !== undefined ? { raw_response: options.rawResponse } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(options.debug?.length ? { debug: options.debug } : {}),
  };
}
