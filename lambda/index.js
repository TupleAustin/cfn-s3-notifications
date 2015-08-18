

var AWS = require('aws-sdk');
var SendResponse = require('./send.response');
var S3 = new AWS.S3({apiVersion: '2006-03-01'});


exports.lambda = S3NotificationCustomResourceLambda;


function S3NotificationCustomResourceLambda(event, context) {

  console.log('REQUEST RECEIVED:\n', JSON.stringify(event));
  var Parameters = event.ResourceProperties;
  var RequestType = event.RequestType;
  
  var invalidation = checkInvalids(Parameters);
  if (invalidation && RequestType !== 'Delete') {
    return reply(invalidation);
  } 
  if (RequestType === 'Create') {
    return Create(Parameters, reply);
  }
  if (RequestType === 'Update') {
    return Update(Parameters, event.OldResourceProperties, reply);
  }
  if (RequestType === 'Delete' && !invalidation) {
    return Delete(Parameters, reply);
  }
  if (RequestType === 'Delete') {
    return reply();
  }
  return reply('The impossible happend! ' +
    'CloudFormation sent an unknown RequestType.');

  function reply(err, data, physicalId) {
    if (err) {
      return SendResponse(event, context, 'FAILED', physicalId, {
        Error: 'FAILED'
      }, Reason);
    }
    return SendResponse(event, context, 'SUCCESS', physicalId, data || {});
  }

};


function Create(Parameters, reply) {
  var Bucket = Parameters.Bucket;
  var NotifConfig = {
    Events: Parameters.Events,
    QueueArn: Parameters.QueueArn
  };
  getExistingNotifs(Bucket, function(err, data) {
    if (err) {
      err.context = 'CREATE was unable to access configs for the provided bucket.';
      return reply(JSON.stringify(err));
    }
    data.QueueConfigurations.push(NotifConfig);
    S3.putBucketNotificationConfiguration({
      Bucket: Bucket,
      NotificationConfiguration: data
    }, function(err, data) {
      if (err) {
        err.context = 'CREATE was unable to apply notification config to bucket.';
        return reply(JSON.stringify(err));
      }
      reply();
    });
  });
  
}

function Update(Parameters, OldParameters, reply) {
  if (noUpdate(Parameters, OldParameters)) {
    return reply();
  }
  var Bucket = Parameters.Bucket;
  var OldBucket = OldParameters.Bucket;
  var NotifConfig = {
    Events: Parameters.Events,
    QueueArn: Parameters.QueueArn
  };
  var OldNotifConfig = {
    Events: OldParameters.Events,
    QueueArn: OldParameters.QueueArn
  }
  if (OldBucket === Bucket) {
    return getExistingNotifs(Bucket, function(err, data) {
      // Ignore bucket removal as implicit deletion
      if (err && err.statusCode !== 404) {
        err.context = 'UPDATE of type SAME BUCKET failed to access existing configs on original bucket.';
        return reply(JSON.stringify(err));
      }
      var existingStatementIndex = findNotifIndex(
        data.QueueConfigurations, OldNotifConfig);
      if (existingStatementIndex === -1) {
        console.log('(WARN) WAS UNABLE TO FIND THE ORIGINAL STATEMENT ON ORIGINAL BUCKET');
        data.QueueConfigurations.push(NotifConfig);
      } else {
        data.QueueConfigurations.splice(existingStatementIndex, 1, NotifConfig);
      }
      S3.putBucketNotificationConfiguration({
        Bucket: Bucket,
        NotificationConfiguration: data
      }, function(err, data) {
        if (err) {
          err.context = 'UPDATE of type SAME BUCKET failed to apply new configs to original bucket.';
          return reply(JSON.stringify(err));
        }
        reply();
      });
    });
  }
  getExistingNotifs(Bucket, function(err, data) {
    if (err) {
      err.context = 'UPDATE of type BUCKET SWAP failed to access existing configs on new bucket.';
      return reply(JSON.stringify(err));
    }
    var existingStatementIndex = findNotifIndex(
      data.QueueConfigurations, NotifConfig);
    if (existingStatementIndex === -1) {
      // Normal case
      data.QueueConfigurations.push(NotifConfig);
    } else {
      // Some nasty ROLLBACK cases
      data.QueueConfigurations.splice(existingStatementIndex, 1, NotifConfig);
    }
    S3.putBucketNotificationConfiguration({
      Bucket: Bucket,
      NotificationConfiguration: data
    }, function(err, data) {
      if (err) {
        err.context = 'UPDATE of type BUCKET SWAP failed to apply notification to new bucket - does the queue allow publicatin from this bucket?';
        return reply(JSON.stringify(err));
      }
      getExistingNotifs(OldBucket, function(err, data) {
        if (err) {
          err.context = 'UPDATE of type BUCKET SWAP failed to access configs on old bucket.';
          return reply(JSON.stringify(err));
        }
        var existingStatementIndex = findNotifIndex(
          data.QueueConfigurations, OldNotifConfig);
        if (existingStatementIndex !== -1) {
          data.QueueConfigurations.splice(existingStatementIndex, 1);
        }
        S3.putBucketNotificationConfiguration({
          Bucket: OldBucket,
          NotificationConfiguration: data
        }, function(err, data) {
          if (err) {
            err.context = 'UPDATE of type BUCKET SWAP failed to remove notification from old bucket.';
            return reply(JSON.stringify(err));
          }
          reply();
        });
      });
    });
  });
}

function Delete(Parameters, reply) {
  var Bucket = Parameters.Bucket;
  var NotifConfig = {
    Events: Parameters.Events,
    QueueArn: Parameters.QueueArn
  };
  getExistingNotifs(Bucket, function(err, data) {
    if (err && err.statusCode === 404) {
      // Bucket no longer there, implicitly deleted...
      return reply();
    }
    if (err) {
      err.context = 'DELETE was unable to get context for existing bucket.';
      return reply(JSON.stringify(err));
    }
    var existingStatementIndex = findNotifIndex(
      data.QueueConfigurations, NotifConfig);
    if (existingStatementIndex !== -1) {
      data.QueueConfigurations.splice(existingStatementIndex, 1);
    }
    S3.putBucketNotificationConfiguration({
      Bucket: Bucket,
      NotificationConfiguration: data
    }, function(err, data) {
      if (err) {
        err.context = 'DELETE was unable to push flushed bucket config.';
        return reply(JSON.stringify(err));
      }
      reply();
    });
  });
}

function getExistingNotifs(bucket, callback) {
  S3.getBucketNotificationConfiguration({
    Bucket: bucket 
  }, function(err, data) {
    if (err) {
      return callback(err, null);
    }
    callback(null, data);
  });
}

function checkInvalids(Parameters) {
  if (!isString(Parameters.Bucket)) {
    return 'String Bucket is required.';
  }
  if (!isString(Parameters.QueueArn)) {
    return 'String QueueArn is required.';
  }
  if (!Parameters.Events ||
    !Array.isArray(Parameters.Events) ||
    !Parameters.Events.length ||
    !Parameters.Events.every(isString)) {
    return 'Array of strings Events is required.';
  }
}

function isString(thing) {
  return 'string' === typeof thing;
}

function findNotifIndex(set, notif) {
  for (var index = 0; index < set.length; index++) {
    if (equalNotifParams(set[index], notif)) {
      return index;
    }
  }
  return -1;
}

function equalNotifParams(a, b) {
  return a.QueueArn === b.QueueArn &&
    a.Events.slice(0).sort().join('|') === b.Events.slice(0).sort().join('|');
}

function noUpdate(a, b) {
  return a.Bucket === b.Bucket && equalNotifParams(a, b);
}
