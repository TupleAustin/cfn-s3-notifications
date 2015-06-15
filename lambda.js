var AWS = require('aws-sdk');
var S3 = new AWS.S3({apiVersion: '2006-03-01'});

var resource = {
  Create: function(Parameters, reply) {
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
    
  },
  Update: function(Parameters, OldParameters, reply) {
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
          console.log('(WARN) WAS UNABLE TO FIND THE STATEMENT ON ORIGINAL BUCKET');
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
  },
  Delete: function(Parameters, reply) {
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
};

function getExistingNotifs(bucket, callback) {
  S3.getBucketNotificationConfiguration({
    Bucket: bucket 
  }, function(err, data) {
    if (err) {
      console.log('Failed to access bucket notification configs!');
      return callback(err, null);
    }
    callback(null, data);
  });
}

function checkInvalids(properties) {
  if (!isString(properties.Bucket)) {
    return 'String Bucket is required.';
  }
  if (!isString(properties.QueueArn)) {
    return 'String QueueArn is required.';
  }
  if (!properties.Events ||
    !Array.isArray(properties.Events) ||
    !properties.Events.length ||
    !properties.Events.every(isString)) {
    return 'Array of strings Events is required.';
  }
}

function isString(thing) {
  return 'string' === typeof thing;
}

exports.lambda = function(event, context) {

  console.log('REQUEST RECEIVED:\n', JSON.stringify(event));
  
  var invalidation = checkInvalids(event.ResourceProperties);
  if (invalidation && event.RequestType !== 'Delete') {
    return reply(invalidation);
  } 
  if (event.RequestType === 'Create') {
    return resource.Create(event.ResourceProperties, reply);
  }
  if (event.RequestType === 'Update') {
    return resource.Update(event.ResourceProperties, event.OldResourceProperties, reply);
  }
  if (event.RequestType === 'Delete' && !invalidation) {
    return resource.Delete(event.ResourceProperties, reply);
  }
  if (event.RequestType === 'Delete') {
    return reply();
  }
  return reply('The impossible happend! ' +
    'CloudFormation sent an unknown RequestType.');

  function reply(err, data, physicalId) {
    var Reason;
    if (err) {
      Reason = (err || 'FAILED').toString();
      return sendResponse(event, context, 'FAILED', physicalId, {
        Error: Reason
      }, Reason);
    }
    return sendResponse(event, context, 'SUCCESS', physicalId, data || {});
  }

};

//Sends response to the pre-signed S3 URL
function sendResponse(event, context, responseStatus, physicalId, responseData, reason) {
   var responseBody = JSON.stringify({
    Status: responseStatus,
    Reason: reason,
    PhysicalResourceId: (
      physicalId ||
      event.PhysicalResourceId ||
      (event.StackId + event.RequestId)),
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: responseData
  });
  
  console.log('RESPONSE BODY:\n', responseBody);

  var https = require('https');
  var url = require('url');
  console.log('REPLYING TO: ', event.ResponseURL);
  var parsedUrl = url.parse(event.ResponseURL);
  var options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };

  var request = https.request(options, function(response) {
    console.log('STATUS: ' + response.statusCode);
    console.log('HEADERS: ' + JSON.stringify(response.headers));
    // Tell AWS Lambda that the function execution is done  
    context.done();
  });

  request.on('error', function(error) {
    console.log('sendResponse Error:\n', error);
    // Tell AWS Lambda that the function execution is done  
    context.done();
  });

  // write data to request body
  request.write(responseBody);
  request.end();
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
