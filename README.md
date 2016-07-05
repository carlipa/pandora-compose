Pandora Compose
=========
[![npm version](https://badge.fury.io/js/%40carlipa%2Fpandora-compose.svg)](https://badge.fury.io/js/%40carlipa%2Fpandora-compose)

A library that provide controls to manipulate docker-compose projects

## RxJS

This library is based on RxJS Observable, which provide more flexibility than raw streams. 

## Docker

This library use `dockerode` to communicate with the `doker` API.

## Docker compose

You can either use a local installation of `docker-compose` or you can use a containerized instance that is pulled or built by Pandora.
This approach guaranties the version of `docker-compose`

## Usage

You must create one instance of `pandora-compose` for each of your compose project, but you can use a single instance of `pandora-docker` which will be shared.
Once created, you can run the common `docker-compose` commands like `build`, `run`, `stop`, etc.

Some methods are pure `docker-compose` calls, while other are `docker` logic.

For example, `getServiceLogs` take a service name, use `docker-compose` to get the corresponding container,
then use `docker` API to get their logs and eventually returns a Promise of two observables: `stdout$` and `stderr$`
which emit their respective standard output logs.

The pure `docker-compose` calls, on the other and, always return an Observable, which emit object like this :

```javascript
{
  timestamp: 1234567890,
  stream: 'stdout',
  source: 'run',
  data: [
    'line1',
    'line2',
    'line3'
  ]
}
```

The `source` property represent the step from which those logs came from.
`preparation` is before the actual run, it's when `docker-compose` is built.
`run` is the actual `docker-compose` run.
The `data` property is an array of strings, since logs are packaged in 500ms windows.
