let Containers = require('./containers');
let validateOptions = require('./validator');
let Playbooks = require('./playbooks');

let Logger;

function doLookup(entities, { host, ..._options }, callback) {
  let integrationOptions = {
    ..._options,
    host: host.endsWith('/') ? host.slice(0, -1) : host
  };
  Logger.trace({ entities, options: integrationOptions }, 'Entities received by integration');

  let phantomPlaybooks = new Playbooks(Logger, integrationOptions);
  let phantomContainers = new Containers(Logger, integrationOptions);

  phantomContainers.getContainers(entities, (err, containers) => {
    if (err) return callback(err, null);

    phantomPlaybooks.listPlaybooks((err, playbooks) => {
      if (err) return callback(err, null);

      const lookupResults = containers.map(({ entity, containers }) => {
        if (containers.length) {
          return {
            entity,
            data: {
              summary: phantomContainers.getSummary(containers),
              details: {
                playbooks: playbooks.data,
                results: containers
              }
            }
          };
        } else if (entity.requestContext.requestType === 'OnDemand') {
          // this was an OnDemand request for an entity with no results
          return {
            entity,
            // do not cache this value because there is no data yet
            isVolatile: true,
            data: {
              summary: ['No Events Found'],
              details: {
                playbooks: playbooks.data,
                onDemand: true,
                entity: entity.value,
                link: `${integrationOptions.host}/browse`
              }
            }
          };
        } else {
          // This was real-time request with no results so we cache it as a miss
          return {
            entity,
            data: null
          };
        }
      });

      Logger.trace({ lookupResults }, 'lookupResults');
      callback(null, lookupResults);
    });
  });
}

function startup(logger) {
  Logger = logger;
}

function runPlaybook(payload, integrationOptions, callback) {
  let containerId = payload.data.containerId;
  let actionId = payload.data.playbookId;
  let entityValue = payload.data.entityValue;

  let phantomPlaybooks = new Playbooks(Logger, integrationOptions);

  if (containerId) {
    _runPlaybookOnExistingContainer(containerId, actionId, phantomPlaybooks, callback);
  } else if (entityValue) {
    _createContainerAndRunPlaybook(entityValue, integrationOptions, actionId, phantomPlaybooks, callback);
  } else {
    const err = {
      err: 'Unexpected Error',
      detail: 'Error: Unexpected value passed when trying to run a playbook'
    };
    Logger.error({ err, containerId, actionId, entity }, 'Error running playbook');
    callback(err);
  }
}

const _runPlaybookOnExistingContainer = (containerId, actionId, phantomPlaybooks, callback) =>
  phantomPlaybooks.runPlaybookAgainstContainer(actionId, containerId, (err, resp) => {
    Logger.trace({ resp, err }, 'Result of playbook run');

    if (!resp && !err) Logger.error({ err: new Error('No response found!') }, 'Error running playbook');

    phantomPlaybooks.getPlaybookRunHistory([containerId], (error, playbooksRan) => {
      if (err || error) {
        Logger.trace({ playbooksRan, error, err }, 'Failed to get Playbook Run History');
        return callback(null, {
          err: err || error,
          ...playbooksRan[0],
          newContainer: false
        });
      }

      callback(null, { ...resp, ...playbooksRan[0], newContainer: false });
    });
  });

function _createContainerAndRunPlaybook(entityValue, integrationOptions, actionId, phantomPlaybooks, callback) {
  let containers = new Containers(Logger, integrationOptions);
  containers.createContainer(entityValue, (err, container) => {
    if (err) return callback({ err: 'Failed to Create Container', detail: err });
    phantomPlaybooks.runPlaybookAgainstContainer(actionId, container.id, (err, resp) => {
      Logger.trace({ resp, err }, 'Result of playbook run');
      if (!resp && !err) Logger.error({ err: new Error('No response found!') }, 'Error running playbook');

      phantomPlaybooks.getPlaybookRunHistory([container.id], (error, playbooksRan) => {
        Logger.trace({ playbooksRan, error }, 'Result of playbook run history');
        if (err || error) {
          Logger.trace({ playbooksRan, error }, 'Failed to get Playbook Run History');
          return callback(null, {
            err: err || error,
            ...playbooksRan[0],
            newContainer: {
              ...container,
              playbooksRan: playbooksRan && playbooksRan[0].playbooksRan,
              playbooksRanCount: playbooksRan && playbooksRan[0].playbooksRan.length
            }
          });
        }
        callback(null, {
          ...resp,
          ...playbooksRan[0],
          newContainer: {
            ...container,
            playbooksRan: playbooksRan[0].playbooksRan,
            playbooksRanCount: playbooksRan[0].playbooksRan.length
          }
        });
      });
    });
  });
}

module.exports = {
  doLookup,
  startup,
  validateOptions,
  onMessage: runPlaybook
};
