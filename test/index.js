import 'source-map-support/register';

import Promise from 'bluebird';
import chai, { assert } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as fs from 'fs';
import * as path from 'path';
import { each, find } from 'lodash';

import PandoraDocker from '@carlipa/pandora-docker';

import PandoraCompose from '../src';

Promise.promisifyAll(fs);

// Chai As Promised configuration
chai.use(chaiAsPromised);

describe('Pandora Compose', function test () {
  this.timeout(600000);

  if (process.env.CI_SERVER === 'yes') {
    console.log('Cannot test pandora-compose, since no docker is available on GitLab CI\n');
    return;
  }

  const composeConfig = {
    projectName: 'col_pandora_compose_test_1',
    composeFilePath: path.resolve(path.join(__dirname, 'fixtures/docker-compose.v2.yml'))
  };

  const compose = new PandoraCompose(composeConfig);

  it('should fail to create a Pandora Compose when config is empty', () => {
    assert.throws(() => {
      const badCompose = new PandoraCompose();
      badCompose.getDocker();
    });
  });

  it('should remove orphaned docker-compose runners', () => {
    const promise = compose.purgeDockerComposeRunners();

    return assert.isFulfilled(promise);
  });

  it('should run compose from docker (pulled)', () => {
    const pandoraComposePull = new PandoraCompose(composeConfig, {
      composeImageName: 'gcoupelant/docker-compose',
      composeImageVersion: '1.6.0',
      composeForceNewImage: true,
      composeMode: 'pull'
    });

    const observable$ = pandoraComposePull._runDockerCompose$(['build']);
    const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
      .then(({ stdout, stderr }) => {
        assert.isArray(stdout);
        assert.isArray(stderr);
      });

    return assert.isFulfilled(promise);
  });

  it('should run compose from docker (built)', () => {
    const pandoraComposeBuild = new PandoraCompose(composeConfig, {
      composeForceNewImage: true,
      composeMode: 'build'
    });

    const observable$ = pandoraComposeBuild._runDockerCompose$(['build']);
    const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
      .then(({ stdout, stderr }) => {
        assert.isArray(stdout);
        assert.isArray(stderr);
      });

    return assert.isFulfilled(promise);
  });

  it('should fail to run compose from docker with wrong mode', () => {
    const pandoraComposePika = new PandoraCompose(composeConfig, {
      composeForceNewImage: true,
      composeMode: 'pikachu'
    });

    const observable$ = pandoraComposePika._runDockerCompose$(['build']);
    const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
      .then(({ stdout, stderr }) => {
        assert.isArray(stdout);
        assert.isArray(stderr);
      });

    return assert.isRejected(promise);
  });

  it('should run compose from docker (using host)', () => {
    const pandoraComposeHost = new PandoraCompose(composeConfig, {
      composeUseHost: true
    });

    const observable$ = pandoraComposeHost._runDockerCompose$(['build']);
    const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
      .then(({ stdout, stderr }) => {
        assert.isArray(stdout);
        assert.isArray(stderr);
      });

    return assert.isFulfilled(promise);
  });

  describe('Observable Workflow', () => {
    it('should build compose project', () => {
      const observable$ = compose.buildImages$({
        noCache: true
      });
      const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.equal(stderr.length, 5);
        });

      return assert.isFulfilled(promise);
    });

    it('should pull compose project images', () => {
      const observable$ = compose.pullImages$();
      const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.equal(stderr.length, 2);
        });

      return assert.isFulfilled(promise);
    });

    it('should up a compose project', () => {
      const observable$ = compose.up$({
        forceRecreate: true
      });
      const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should get containers from compose', () => {
      const promise = compose
        .getContainers()
        .map((container) => container.inspectAsync())
        .each((containerData) => {
          assert.isObject(containerData);
          assert.property(containerData.Config.Labels, 'com.docker.compose.config-hash');
        })
        .then((containers) => {
          assert.equal(containers.length, 5);
        });

      return assert.isFulfilled(promise);
    });

    it('should get containers ports from compose', () => {
      const promise = compose
        .getContainers()
        .map((container) => container.inspectAsync())
        .map((containerData) => {
          return {
            service: PandoraCompose.getComposeServiceName(containerData),
            container: containerData.Name,
            ports: PandoraDocker.getHostPorts(containerData)
          };
        })
        .then((containers) => {
          const mongoServiceContainer = find(containers, { service: 'mongo' });
          assert.equal(mongoServiceContainer.ports.length, 1);
          assert.equal(mongoServiceContainer.ports[0].containerPort, '27017');
          assert.equal(mongoServiceContainer.ports[0].protocol, 'tcp');
          assert.property(mongoServiceContainer.ports[0], 'hostPort');
        });

      return assert.isFulfilled(promise);
    });

    it('should get logs from compose service', () => {
      const promise = compose
        .getServiceLogs('mongo')
        .then(({ stdout$, stderr$ }) => {
          return Promise.props({
            stdout: stdout$.toArray().toPromise(),
            stderr: stderr$.toArray().toPromise()
          });
        })
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.isArray(stderr);
        });

      return assert.isFulfilled(promise);
    });

    it('should fail to get logs from a missing compose service', () => {
      const promise = compose
        .getServiceLogs('pikachu')
        .then(({ stdout$, stderr$ }) => {
          return Promise.props({
            stdout: stdout$.toArray().toPromise(),
            stderr: stderr$.toArray().toPromise()
          });
        })
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.isArray(stderr);
        });

      return assert.isRejected(promise, Error, 'No such service');
    });

    it('should get logs from compose service (using follow)', () => {
      const promise = new Promise((resolve) => {
        compose
          .getServiceLogs('aurora', { follow: true, tail: 0 })
          .then(({ stdout$, stderr$ }) => {
            const outData = [];
            const errData = [];

            const stdoutSubscription = stdout$.subscribe((x) => outData.push(x));
            const stderrSubscription = stderr$.subscribe((x) => errData.push(x));

            setTimeout(() => {
              stdoutSubscription.unsubscribe();
              stderrSubscription.unsubscribe();

              resolve({ outData, errData });
            }, 5000);
          });
      })
        .then(({ outData, errData }) => {
          assert.isAbove(outData.length, 0);
          assert.isArray(errData);
        });

      return assert.isFulfilled(promise);
    });

    it('should get compose container status', () => {
      const promise = compose
        .getContainers()
        .map((container) => container.inspectAsync())
        .map((containerData) => {
          return {
            service: PandoraCompose.getComposeServiceName(containerData),
            state: containerData.State
          };
        })
        .then((results) => {
          assert.equal(results.length, 5);
          each(results, (container) => {
            assert.property(container, 'service');
            assert.property(container, 'state');
            assert.property(container.state, 'Status');
            assert.property(container.state, 'Running');
            assert.property(container.state, 'Pid');
            assert.property(container.state, 'ExitCode');
          });
        });

      return assert.isFulfilled(promise);
    });

    it('should stop a compose project', () => {
      const observable$ = compose.stop$({
        timeout: 3
      });
      const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should start a compose project', () => {
      const observable$ = compose.start$();
      const promise = PandoraCompose.dockerComposeRunObservableToObject(observable$)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should pause and unpause a compose project', () => {
      const promise = Promise.resolve()
        .then(() => compose.pause$())
        .then(PandoraCompose.dockerComposeRunObservableToObject)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        })
        .then(() => compose.unpause$())
        .then(PandoraCompose.dockerComposeRunObservableToObject)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should remove stopped containers of a compose project', () => {
      const promise = compose
        .stop$({
          timeout: 3
        })
        .toPromise()
        .then(() => compose.rm$({
          removeVolumes: true
        }))
        .then(PandoraCompose.dockerComposeRunObservableToObject)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should get events of a compose service', () => {
      const promise = compose
        .up$({
          forceRecreate: false
        })
        .toPromise()
        .then(() => compose.getServiceEvents('mongo'))
        .then((observable$) => {
          const output = [];

          observable$.subscribe((x) => {
            try {
              output.push(JSON.parse(x));
            } catch (err) {
              output.push(x);
            }
          });

          return compose
            .stop$({ timeout: 2 })
            .toPromise()
            .thenReturn(output);
        })
        .then((output) => {
          assert.isArray(output);
        });

      return assert.isFulfilled(promise);
    });

    it('should fail to get events of a missing compose service', () => {
      const promise = compose
        .up$({
          forceRecreate: false
        })
        .toPromise()
        .then(() => compose.getServiceEvents('pikachu'))
        .then((observable$) => {
          const output = [];

          observable$.subscribe((x) => {
            try {
              output.push(JSON.parse(x));
            } catch (err) {
              output.push(x);
            }
          });

          return compose
            .stop$({ timeout: 2 })
            .toPromise()
            .thenReturn(output);
        })
        .then((output) => {
          assert.isArray(output);
        });

      return assert.isRejected(promise, Error, 'No such service');
    });

    it('should down a compose project', () => {
      const promise = compose
        .up$({
          forceRecreate: false
        })
        .toPromise()
        .then(() => compose.down$({
          removeVolumes: true
        }))
        .then(PandoraCompose.dockerComposeRunObservableToObject)
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });
  });

  describe('Promise Workflow', () => {
    it('should build compose project', () => {
      const promise = compose
        .buildImages({
          noCache: true
        })
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.equal(stderr.length, 5);
        });

      return assert.isFulfilled(promise);
    });

    it('should pull compose project images', () => {
      const promise = compose
        .pullImages()
        .then(({ stdout, stderr }) => {
          assert.isAbove(stdout.length, 0);
          assert.equal(stderr.length, 2);
        });

      return assert.isFulfilled(promise);
    });

    it('should up a compose project', () => {
      const promise = compose
        .up({
          forceRecreate: true
        })
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should stop a compose project', () => {
      const promise = compose.stop({
        timeout: 3
      })
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should start a compose project', () => {
      const promise = compose.start()
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should pause and unpause a compose project', () => {
      const promise = Promise.resolve()
        .then(() => compose.pause())
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        })
        .then(() => compose.unpause())
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should remove stopped containers of a compose project', () => {
      const promise = compose
        .stop({
          timeout: 3
        })
        .then(() => compose.rm({
          removeVolumes: true
        }))
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });

    it('should down a compose project', () => {
      const promise = compose
        .up({
          forceRecreate: false
        })
        .then(() => compose.down({
          removeVolumes: true
        }))
        .then(({ stdout, stderr }) => {
          assert.isArray(stdout);
          assert.isAbove(stderr.length, 0);
        });

      return assert.isFulfilled(promise);
    });
  });
});
