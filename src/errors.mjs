export class BenchError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BenchError";
    this.code = code;
    this.details = details;
  }
}

export function asFailure(error, fallbackCode = "framework_failure") {
  if (error instanceof BenchError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}
