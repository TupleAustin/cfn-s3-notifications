module.exports = sendRequest;

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