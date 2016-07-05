import 'source-map-support/register';

import Promise, { promisifyAll } from 'bluebird';
import { PassThrough as StreamPassThrough } from 'stream';
import path from 'path';
import { spawn } from 'child_process';
import { defaults, find, isArray, map, pick } from 'lodash';
import { pack as tarPack } from 'tar-fs';
import { Observable } from '@reactivex/rxjs';

import PandoraDocker from '@carlipa/pandora-docker';
import { DockerRunError } from './errors';

global.Rx = {
  config: {
    Promise
  }
};

export default class PandoraCompose {
  /**
   * @param composeImageName the docker-compose image name (default: 'carlipa/docker-compose')
   * @param composeImageVersion the docker-compose version (default: 1.7.1)
   * @param composeMode mode to get the docker-compose image (default: 'build')
   * @param composeForceNewImage re-create de docker-compose image on each call (default: false)
   * @param composeUseHost use the host docker-compose cli instead of a containerized one (default: false)
   * @param dockerOptions the options used by the underlying @carlipa/pandora-docker, if no one is provided
   * @param composeContainerLabelRoot the base string used for container labels
   * @param composeRunnerLabel the label value of the docker-compose runner container
   * @param env additional environment variables
   */
  static defaults = {
    composeImageName: process.env.DOCKER_COMPOSE_IMAGE_NAME || 'carlipa/docker-compose',
    composeImageVersion: process.env.DOCKER_COMPOSE_IMAGE_VERSION || '1.7.1',
    composeMode: 'build',
    composeForceNewImage: false,
    composeUseHost: false,
    dockerOptions: {},
    composeContainerLabelRoot: 'com.pandora.compose',
    composeRunnerLabel: 'docker-compose-runner',
    env: {}
  };

  /**
   * The dockerode instance
   * @private
   */
  _docker = null;

  /**
   * Pandra Compose Constructor
   * @param projectName the docker-compose project name
   * @param projectDir the directory of the project
   * @param composeFilePath the docker-compose file to use
   * @param pandoraDocker the Pandora Docker instance to use (if not provided, will create a new one)
   * @param options
   */
  constructor ({ projectName, projectDir, composeFilePath, pandoraDocker } = {}, options = {}) {
    if (!projectName && !projectDir && !composeFilePath) {
      throw new Error('At least a project name, directory or compose file path is required');
    }

    this.project = {
      projectName,
      projectDir,
      composeFilePath
    };

    this.config = defaults({}, pick(options, ...Object.keys(PandoraCompose.defaults)), PandoraCompose.defaults);

    const _pandoraDocker = pandoraDocker || new PandoraDocker(this.config.dockerOptions);
    this._docker = _pandoraDocker.getDocker();
  }

  /**
   * Using the container data, returns its associated docker-compose service name
   * @param containerData the container data
   * @returns {String}
   */
  static getComposeServiceName (containerData) {
    return containerData.Config.Labels['com.docker.compose.service'];
  }

  /**
   * Given the Observable of a _runDockerCompose, split it into multiple observables:
   *  - preparation: the messages emitted during docker-compose preparation
   *  - stdout: the stdout of the run itself
   *  - stderr: the stderr of the run itself
   * @param observable the _runDockerCompose observable
   * @returns {{preparation: Observable, stdout: Observable, stderr: Observable}}
   */
  static demuxRunObservable (observable) {
    const published = observable.share();

    return {
      preparation: published.filter((x) => x.source === 'preparation'),
      stdout: published.filter((x) => x.source === 'run' && x.stream === 'out'),
      stderr: published.filter((x) => x.source === 'run' && x.stream === 'err')
    };
  }

  /**
   * Convert an observable from a _runDockerCompose demux to a promise of an array
   * @param observable$ the Observable (must emit data in the form of {data: XXXX, ...}
   * @returns {Promise}
   */
  static observableToArray (observable$) {
    return observable$
      .reduce((acc, x) => {
        return acc.concat(x.data);
      }, [])
      .toPromise();
  }

  /**
   * Shorthand for doing demuxRunObservable and observableToArray to its results
   * @param observable$ the _runDockerCompose observable
   * @returns {Promise} a Promise of an object containing an array for each Observable of the run
   */
  static dockerComposeRunObservableToObject (observable$) {
    const { preparation, stdout, stderr } = PandoraCompose.demuxRunObservable(observable$);

    return Promise
      .props({
        preparation: PandoraCompose.observableToArray(preparation),
        stdout: PandoraCompose.observableToArray(stdout),
        stderr: PandoraCompose.observableToArray(stderr)
      });
  }

  /**
   * Converts a flowing readable stream to an Observable sequence.
   * @param {Stream} stream A stream to convert to a observable sequence.
   * @returns {Observable} An observable sequence which fires on each 'data' event as well as handling 'error' and
   * finish events like `end` or `finish`.
   */
  static fromReadableStream$ (stream) {
    stream.pause();

    return Observable.create((observer) => {
      function dataHandler (data) {
        observer.next(data);
      }

      function errorHandler (err) {
        observer.error(err);
      }

      function endHandler () {
        observer.complete();
      }

      stream.addListener('data', dataHandler);
      stream.addListener('error', errorHandler);
      stream.addListener('end', endHandler);

      stream.resume();

      return () => {
        stream.removeListener('data', dataHandler);
        stream.removeListener('error', errorHandler);
        stream.removeListener('end', endHandler);
      };
    }).publish().refCount();
  }

  /**
   * Execute a docker-compose command inside an ephemera container
   * @param command the docker-compose command
   * @returns {Observable} on observable of the docker run multiplexed streams
   * @private
   */
  _runDockerComposeFromDocker$ (command) {
    // Docker compose image tag
    const composeImageTag = `${this.config.composeImageName}:${this.config.composeImageVersion}`;

    // Project
    const projectName = this.project.projectName;
    const composeFilePath = this.project.composeFilePath;

    // Current working directory
    const projectDir = this.project.projectDir || composeFilePath ? path.dirname(composeFilePath) : process.cwd();

    const volumes = {
      '/var/run/docker.sock': {},
      [projectDir]: {}
    };

    const dockerComposeImageObservable$ = Observable.defer(() => {
      const dockerComposeImagePromise = this._docker
      // First, the docker-compose image
        .listImagesAsync()
        .then((images) => {
          if (!this.config.composeForceNewImage) {
            // Check if image is present
            return find(images, (image) => {
              return image.RepoTags.indexOf(composeImageTag) > -1;
            });
          }
          return null;
        });

      return Observable.fromPromise(dockerComposeImagePromise)
        .flatMap((composeImage) => {
          if (composeImage) {
            return Observable.of({
              timestamp: Date.now(),
              source: 'preparation',
              data: ['Pandora Compose: docker-compose image already available']
            });
          }

          let promise;
          // If no image...
          if (this.config.composeMode === 'pull') {
            // ...pull it
            promise = this._docker
              .pullAsync(composeImageTag);
          } else if (this.config.composeMode === 'build') {
            // ...build it
            const tarStream = tarPack(path.resolve(__dirname, './dockerfiles/docker-compose'));
            promise = this._docker
              .buildImageAsync(tarStream, {
                t: composeImageTag,
                buildargs: {
                  COMPOSE_VERSION: this.config.composeImageVersion
                }
              });
          } else {
            throw new Error(`Cannot get docker-compose image using mode: ${this.config.composeMode}`);
          }

          return Observable
            .fromPromise(promise)
            // Convert this stream to an observable, and flatten it
            .flatMap(::PandoraCompose.fromReadableStream$)
            .map((x) => {
              try {
                const data = JSON.parse(x.toString());
                return data.stream ? data.stream : data;
              } catch (err) {
                return x;
              }
            })
            .do((x) => {
              // Check for errors
              if (x.error) {
                throw new Error(x.error);
              }
            })
            // Split the observable into windows of 500ms
            .windowTime(500)
            // Flatten the windows to array
            .flatMap((x) => x.toArray())
            // Filter empty windows
            .filter((x) => x.length)
            .startWith([`Pandora Compose: ${this.config.composeMode}`])
            // Add stream name and timestamp
            .map((x) => ({ timestamp: Date.now(), source: 'preparation', data: x }));
        });
    });

    const dockerRunObservable$ = Observable.defer(() => {
      // The std streams
      const outStream = new StreamPassThrough();
      const errStream = new StreamPassThrough();

      const runPromise = new Promise((resolve, reject) => {
        const customEnv = map(this.config.env, (value, key) => `${key}=${value}`);

        this._docker.run(composeImageTag, command, [outStream, errStream], {
          Tty: false,
          Volumes: volumes,
          WorkingDir: projectDir,
          Env: [
            ...customEnv,
            projectName ? `COMPOSE_PROJECT_NAME=${projectName}` : undefined,
            composeFilePath ? `COMPOSE_FILE=${composeFilePath}` : undefined
          ],
          Labels: {
            [`${this.config.composeContainerLabelRoot}.role`]: this.config.composeRunnerLabel
          }
        }, {
          Binds: [
            `${projectDir}:${projectDir}`,
            '/var/run/docker.sock:/var/run/docker.sock'
          ],
          Privileged: true
        }, (err, data, container) => {
          // If an error occurred and no container, reject here
          if (!container && err) {
            reject(err);
            return;
          }
          // If the container exists, try to remove it
          container.remove({ v: true }, (containerRemoveErr) => {
            if (containerRemoveErr) {
              return reject(containerRemoveErr);
            }
            // If the "docker.run" has thrown an error, reject here
            if (err) {
              return reject(err);
            }

            if (data.StatusCode !== 0) {
              return reject(new DockerRunError(data.StatusCode));
            }
            return resolve();
          });
        });
      });

      function streamToObservable$ (stream, name) {
        return Observable
        // Create an Observable that emit the stream
          .of(stream)
          // Convert this stream to an observable, and flatten it
          .flatMap(::PandoraCompose.fromReadableStream$)
          // Break stream's string by "\n", and remove empty lines
          .flatMap((data) => Observable.from(data.toString().split('\n').filter((x) => x.length)))
          // Split the observable into windows of 500ms
          .windowTime(500)
          // Flatten the windows to array
          .flatMap((x) => x.toArray())
          // Filter empty windows
          .filter((x) => x.length)
          // Add stream name and timestamp
          .map((x) => ({ timestamp: Date.now(), stream: name, source: 'run', data: x }));
      }

      const streamsObservable$ = Observable
        .merge(streamToObservable$(outStream, 'out'), streamToObservable$(errStream, 'err'));

      return Observable
        .concat(streamsObservable$, Observable.fromPromise(runPromise));
    });

    return Observable.concat(dockerComposeImageObservable$, dockerRunObservable$).filter((x) => !!x);
  }

  /**
   * Execute a docker-compose command from the host
   * @param command the docker-compose command
   * @returns {Observable} a promise of docker-compose multiplexed stream
   * @private
   */
  _runDockerComposeFromHost$ (command) {
    const projectCommand = this.project.projectName ? ['-p', this.project.projectName] : [];
    const composeFileCommand = this.project.composeFilePath ? ['-f', this.project.composeFilePath] : [];

    const child = spawn('docker-compose', [...projectCommand, ...composeFileCommand, ...command], {
      cwd: this.project.projectDir,
      env: {
        ...process.env,
        ...this.config.env
      }
    });

    const endPromise = new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code) {
          reject(new DockerRunError(code));
        } else {
          resolve();
        }
      });

      child.on('error', reject);
    });

    function streamToObservable$ (stream, name) {
      return Observable
      // Create an Observable that emit the stream
        .of(stream)
        // Convert this stream to an observable, and flatten it
        .flatMap(::PandoraCompose.fromReadableStream$)
        // Break stream's string by "\n", and remove empty lines
        .flatMap((data) => Observable.from(data.toString().split('\n').filter((x) => x.length)))
        // Split the observable into windows of 500ms
        .windowTime(500)
        // Flatten the windows to array
        .flatMap((x) => x.toArray())
        // Filter empty windows
        .filter((x) => x.length)
        // Add stream name and timestamp
        .map((x) => ({ timestamp: Date.now(), stream: name, source: 'run', data: x }));
    }

    const streamsObservable$ = Observable
      .merge(streamToObservable$(child.stdout, 'out'), streamToObservable$(child.stderr, 'err'));

    return Observable
      .concat(streamsObservable$, Observable.fromPromise(endPromise))
      .filter((x) => !!x);
  }

  /**
   * Execute a docker-compose command
   * @param command the docker-compose command
   * @returns {Observable} a promise of docker-compose multiplexed stream
   * @private
   */
  _runDockerCompose$ (command) {
    // Verifications
    if (!isArray(command)) {
      throw new Error('"command" must be an array');
    }
    // Remove the "docker-compose" part if present
    if (command[0] === 'docker-compose') {
      command.shift();
    }

    if (this.config.composeUseHost) {
      return this._runDockerComposeFromHost$(command);
    }
    return this._runDockerComposeFromDocker$(command);
  }

  /**
   * Use the dockerode built-in demultiplexer, stdout and stderr streams are ended when stream ends
   * @param stream the multiplexed stream
   * @param outStream stdout stream
   * @param errStream stderr stream
   * @private
   */
  _demuxStream (stream, outStream, errStream) {
    this._docker.modem.demuxStream(stream, outStream, errStream);
    stream.on('end', () => {
      outStream.end();
      errStream.end();
    });
  }

  /**
   * Using an array of containers Ids, map a dockerode container object
   * @param containersId the containers Ids
   * @returns {Promise}
   * @private
   */
  _getContainersInfo (containersId) {
    return Promise.map(containersId, (containerId) => promisifyAll(this._docker.getContainer(containerId)));
  }

  /**
   * Returns the dockerode instance
   * @returns {*}
   */
  getDocker () {
    return this._docker;
  }

  /**
   * Remove docker-compose runner inactive zombies
   */
  purgeDockerComposeRunners () {
    return this._docker
      .listContainersAsync({
        filters: {
          label: [
            `${this.config.composeContainerLabelRoot}.role=${this.config.composeRunnerLabel}`
          ],
          status: [
            'exited'
          ]
        }
      })
      .map((container) => {
        return Promise
          .fromNode((callback) => {
            this._docker.getContainer(container.Id).remove(callback);
          })
          .then(() => container.Id);
      });
  }

  /**
   * Returns the list of docker-compose dockerode containers of the project
   * @returns {Promise}
   */
  getContainers () {
    return PandoraCompose
      .dockerComposeRunObservableToObject(this._runDockerCompose$(['ps', '-q']))
      .then(({ stdout }) => stdout)
      .then(this._getContainersInfo.bind(this));
  }

  /**
   * Returns a Promise of Observables that emit the stdout and stderr of the container of a service of the
   * docker-compose project
   * @param service the service name
   * @param stdout use stdout stream (default: true)
   * @param stderr use stderr stream (default: false)
   * @param follow live stream (default: false)
   * @param since UNIX timestamp (integer) to filter logs. Specifying a timestamp will only output log-entries since
   * that timestamp (default: null)
   * @param timestamps print timestamps for every log line (default: null)
   * @param tail Output specified number of lines at the end of logs (default: 100)
   * @returns {Promise}
   */
  getServiceLogs (service, { stdout = true, stderr = false, follow = false, since, timestamps, tail = 100 } = {}) {
    return this.getContainers()
      .filter((container) => {
        return container
          .inspectAsync()
          .then((containerData) => PandoraCompose.getComposeServiceName(containerData) === service);
      })
      .then((containers) => {
        if (containers.length === 1) {
          return containers[0];
        }
        throw new Error('No such service');
      })
      .then((container) => container.logsAsync({ follow, stdout, stderr, since, timestamps, tail }))
      .then((stream) => {
        const outStream = new StreamPassThrough();
        const errStream = new StreamPassThrough();

        this._demuxStream(stream, outStream, errStream);

        function streamToObservable$ (streamToTransform) {
          return Observable
            .of(streamToTransform)
            .flatMap(::PandoraCompose.fromReadableStream$)
            .flatMap((data) => Observable.from(data.toString().split('\n').filter((x) => x.length)));
        }

        return {
          stdout$: streamToObservable$(outStream),
          stderr$: streamToObservable$(errStream)
        };
      });
  }

  /**
   * Returns a Promise of an Observable that emit the events of the container of a service of the docker-compose project
   * Uses pure docker events, not docker-compose ones
   * @param service the service name
   * @param since UNIX timestamp (integer) (default: null)
   * @param until UNIX timestamp (integer) (default: null)
   * @returns {Promise.<Observable>}
   */
  getServiceEvents (service, { since, until } = {}) {
    return this.getContainers()
      .filter((container) => {
        return container
          .inspectAsync()
          .then((containerData) => PandoraCompose.getComposeServiceName(containerData) === service);
      })
      .then((containers) => {
        if (containers.length === 1) {
          return containers[0];
        }
        throw new Error('No such service');
      })
      .then((container) => {
        return this._docker.getEventsAsync({
          since,
          until,
          filters: {
            container: [container.id]
          }
        });
      })
      .then((stream) => {
        return Observable
          .of(stream)
          .flatMap(::PandoraCompose.fromReadableStream$)
          .map((x) => x.toString());
      });
  }

  /**
   * Build a compose project
   * @param noCache if true, will not use cache (default: false)
   * @returns {Observable} an Observable of the build stream
   */
  buildImages$ ({ noCache = false } = {}) {
    const command = ['build'];
    if (noCache) {
      command.push('--no-cache');
    }
    return this._runDockerCompose$(command);
  }

  buildImages () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.buildImages$.apply(this, arguments));
  }

  /**
   * Pull a compose project's images
   * @returns {Observable} an Observable of the pull stream
   */
  pullImages$ () {
    return this._runDockerCompose$(['pull']);
  }

  pullImages () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.pullImages$.apply(this, arguments));
  }

  /**
   * Start the compose project in detached mode
   * @param forceRecreate if true, will recreate all containers (default: false)
   * @returns {Observable} an Observable of the up stream
   */
  up$ ({ forceRecreate = false } = {}) {
    const command = ['up', '-d'];
    if (forceRecreate) {
      command.push('--force-recreate');
    }
    return this._runDockerCompose$(command);
  }

  up () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.up$.apply(this, arguments));
  }

  /**
   * Stop the compose project containers
   * @param timeout the docker-compose stop timeout value (default: 10)
   * @returns {Observable} an Observable of the stop stream
   */
  stop$ ({ timeout = 10 } = {}) {
    return this._runDockerCompose$(['stop', '-t', String(timeout)]);
  }

  stop () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.stop$.apply(this, arguments));
  }

  /**
   * Start the compose project stopped containers
   * @returns {Observable} an Observable of the stop stream
   */
  start$ () {
    return this._runDockerCompose$(['start']);
  }

  start () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.start$.apply(this, arguments));
  }

  /**
   * Pause the compose project running containers
   * @returns {Observable} an Observable of the stop stream
   */
  pause$ () {
    return this._runDockerCompose$(['pause']);
  }

  pause () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.pause$.apply(this, arguments));
  }

  /**
   * Unpause the compose project paused containers
   * @returns {Observable} an Observable of the stop stream
   */
  unpause$ () {
    return this._runDockerCompose$(['unpause']);
  }

  unpause () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.unpause$.apply(this, arguments));
  }

  /**
   * Remove the compose project stopped containers
   * @param removeVolumes if true, will remove volumes associated with containers (default: false)
   * @returns {Observable} an Observable of the stop stream
   */
  rm$ ({ removeVolumes = false } = {}) {
    const command = ['rm', '-f'];
    if (removeVolumes) {
      command.push('-v');
    }
    return this._runDockerCompose$(command);
  }

  rm () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.rm$.apply(this, arguments));
  }

  /**
   * Stop containers and remove them
   * @param removeVolumes if true, will remove volumes associated with containers (default: false)
   * @returns {Observable} an Observable of the down stream
   */
  down$ ({ removeVolumes = false } = {}) {
    const command = ['down'];
    if (removeVolumes) {
      command.push('-v');
    }
    return this._runDockerCompose$(command);
  }

  down () {
    return PandoraCompose.dockerComposeRunObservableToObject(this.down$.apply(this, arguments));
  }
}
