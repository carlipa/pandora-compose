import 'source-map-support/register';

export class DockerRunError extends Error {
  constructor (statusCode) {
    super('DockerRunError');
    this.statusCode = statusCode;
  }
}
