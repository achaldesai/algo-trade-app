export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export default RepositoryConflictError;
