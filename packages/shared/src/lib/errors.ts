import { Data } from 'effect';

export class DataError extends Data.TaggedError('DataError')<{
  message: string;
  cause?: unknown;
}> {}

export class EvaluatorError extends Data.TaggedError('EvaluatorError')<{
  evaluatorName: string;
  message: string;
  cause?: unknown;
}> {}

export class TaskError extends Data.TaggedError('TaskError')<{
  taskIndex: number;
  message: string;
  cause?: unknown;
}> {}

export class OutputError extends Data.TaggedError('OutputError')<{
  message: string;
  cause?: unknown;
}> {}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  message: string;
  cause?: unknown;
}> {}