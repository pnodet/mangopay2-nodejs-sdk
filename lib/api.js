var _ = require('underscore');
var path = require('path');
var RestClient = require('node-rest-client').Client;
var Promise = require('promise');
var querystring = require('querystring');

var apiMethods = require('./apiMethods');
var apiModels = require('./models');
var apiServices = require('./services');

/**
 *
 * @param {string} username     Mangopay username
 * @param {string} apiKey       Mangopay api key
 * @returns {string}            The header value base64 encoded for requesting the authentication key
 * @private
 */
function _getBasicAuthHash(username, apiKey) {
    return 'Basic ' + Buffer.from(username + ':' + apiKey).toString('base64');
}

var Api = function(config) {
    var defaultConfig = require('./config');
    config = this.config = _.extend({}, defaultConfig, config);

    this.errorHandler = config.errorHandler;

    this.rateLimits = [];

    /**
     * Add default request configuration options
     */
    _.extend(this.requestOptions, {
        requestConfig: {
            timeout: config.connectionTimeout
        },
        responseConfig: {
            timeout: config.responseTimeout
        },
        /**
         * Path options are replacing the ${placeholders} from apiMethods
         */
        path: {
            clientId: config.clientId,
            apiVersion: config.apiVersion
        },
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'MangoPay V2 SDK Nodejs ' + require('../package.json').version
        }
    });

    var client = this.client = new RestClient(this.requestOptions);

    /**
     * Iterate trough API methods and register them into the rest client
     */
    _.each(apiMethods, function(method, key){
        client.registerMethod(key, config.baseUrl + method[0], method[1]);
    });

    /**
     * Adds the services to API object
     */
    this._servicesLoader();

    return this;
};

Api.prototype = {
    config: require('./config'),

    requestOptions: {
        headers: {}
    },

    /**
     * Checks if callback is a function or not, and passes the options
     * @param {Object, Function}    callback
     * @param {Object}              options
     * @param {Object}              params      Additional params that extend options
     */
    _getOptions: function(callback, options, params) {
        var options = options || ((_.isObject(callback) && !_.isFunction(callback)) ? callback : {});
        if (params) {
            options = _.extend({}, options, params);
        }

        return options
    },

    /**
     * Main API resource request method
     * @param {string}      method      Mangopay API method to be called
     * @param {function}    callback    Callback function
     * @param {object}      options     Hash of configuration to be passed to request
     * @returns {object} request promise
     */
    method: function(method, callback, options) {
        options = this._getOptions(callback, options);

        if (this.config.debugMode) {
            this.config.logClass(method, options);
        }

        /**
         * If data has parse method, call it before passing data
         */
        if (options.data && options.data instanceof this.models.EntityBase) {
            options.data = this.buildRequestData(options.data);
        } else if (options.data && options.data.toJSON) {
            options.data = options.data.toJSON();
        }
        var self = this;

        /**
         * If there's no OAuthKey, request one
         */
        if (!this.requestOptions.headers.Authorization || this.isExpired()) {
            return new Promise(function(resolve, reject){
                self.authorize()
                    .then(function(){
                        self.method.call(self, method, function(data, response){
                            // Check if we have to wrap data into a model
                            if (_.isFunction(callback)) {
                                callback(data, response);
                            }
                        }, options)
                            .then(resolve)
                            .catch(reject)
                    })
                    .catch(reject);
            });
        }

        /**
         * Extend default request options with custom ones, if present
         */
        var requestOptions = _.extend({}, this.requestOptions, options);

        /**
         * If we have custom headers and they don't contain Content-Type, we have to prevent them to override Authentication header
         */
        if (options && options.headers && options.headers['Content-Type'] === undefined) {
            _.extend(requestOptions.headers, this.requestOptions.headers, options.headers);
        }

        /**
         * Append the path placeholders in order to build the proper url for the request
         */
        if (options && options.path) {
            _.extend(requestOptions.path, this.requestOptions.path, options.path);
        }

        return this._requestApi(requestOptions, method, callback);
    },

    _requestApi: function(requestOptions, method, callback) {
      var self = this;

      return new Promise(function(resolve, reject){
          if (!method) throw new Error('Method is required in order to perform a API server request');
          var request;
          /**
           * Allow direct requests: api.method('post', function(){ ... });
           */
          if (['post', 'get', 'put'].indexOf(method) === -1) {
            request = self.client.methods[method].bind(self, requestOptions);
          } else {
            if (!requestOptions.url) throw new Error('Url must be specified when doing a manual request');
            request = self.client[method].bind(self, requestOptions.url, requestOptions);
          }

          var resolveWithFullResponse = requestOptions.resolveWithFullResponse || false;

          request(function(data, response){
            var resolveArgument = (resolveWithFullResponse) ? _.extend(response, {body: data}) : data;

            if (response.statusCode === 401) {
                // Authorization error
                self.authorize()
                    .then(function(){
                        self.method.call(self, method, function(data, response){
                            var resolveArgument = (resolveWithFullResponse) ? response : data;
                            // Check if we have to wrap data into a model
                            if (_.isFunction(callback)) {
                                callback(resolveArgument, response);
                            }
                        }, requestOptions)
                            .then(resolve)
                            .catch(reject)
                    })
                    .catch(reject)
            } else if (response.statusCode < 200 || response.statusCode > 299) {
                if (_.isFunction(callback)) callback(resolveArgument, response);
                self.errorHandler(data.Message, data);
                reject(resolveArgument, response);
            } else {
                setRateLimits(self, response.headers);
                if (['post', 'get', 'put'].indexOf(method) === -1) {
                  /**
                   * Add raw response data under 'data' property of the object and at the root of the object,
                   * when the request is not "manual" - post, get, put
                   */
                  _.extend(requestOptions.data, data, {data: data});

                  /**
                   * Check if we have to instantiate returned data
                   */
                  if (requestOptions.dataClass && !resolveWithFullResponse) {
                      if (_.isArray(data)) {
                          resolveArgument = _.map(data, function(dataItem) {
                              return new requestOptions.dataClass(dataItem);
                          })
                      } else {
                          resolveArgument = new requestOptions.dataClass(data);
                      }
                  }
                }
                if (_.isFunction(callback)) {
                    callback(resolveArgument, response);
                }
                resolve(resolveArgument);
            }
          }).on('error', function (err) { reject(err.message); });
      });
    },

    buildRequestData: function(entity) {
        var self = this;

        var blackList = entity.getReadOnlyProperties();
        var requestDataKeys = _.difference(_.keys(entity), blackList);
        var requestData = _.pick(entity, requestDataKeys);

        _.each(_.keys(entity), function(key){
            if (self.canReadSubRequestData(entity, key)) {
                _.extendOwn(requestData, entity[key].toJSON());
            }
        });

        return requestData;
    },

    canReadSubRequestData: function(entity, propertyName) {
        if (entity instanceof this.models.PayIn && (propertyName === 'PaymentDetails' || propertyName === 'ExecutionDetails')) {
            return true;
        }

        if (entity instanceof this.models.PayOut && propertyName === 'MeanOfPaymentDetails') {
            return true;
        }

        if (entity instanceof this.models.BankAccount && propertyName === 'Details') {
            return true;
        }

        return false;
    },

    /**
     * OAuth2 authorization mechanism. After authorization request, calls the callback with returned authorization data
     * @param {function}    callback
     * @returns {object} request promise
     */
    authorize: function(callback) {
        var self = this;

        var auth_post_data = querystring.stringify({
            'grant_type': 'client_credentials'
        });

        //'Content-Length' doesn't need to be set, it gets set automatically (node-rest-client v3.1.0)
        return new Promise(function(resolve, reject){
            self.client.methods.authentication_oauth(_.extend({}, self.requestOptions, {
                data: auth_post_data,
                headers: _.extend({}, self.requestOptions.headers, {
                    'Authorization': _getBasicAuthHash(self.config.clientId, self.config.clientApiKey),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // 'Content-Length': Buffer.byteLength(auth_post_data)
                })
            }), function(data) {
                // Authorization succeeded
                if (data.token_type && data.access_token) {
                    _.extend(self.requestOptions.headers, {
                        'Authorization': data.token_type + ' ' + data.access_token
                    });
                    // Multiplying expires_in (seconds) by 1000 since JS getTime() is expressed in ms
                    self.authorizationExpireTime = new Date().getTime() + ( data.expires_in * 1000 );
                    resolve(data);
                    if (_.isFunction(callback)) {
                        callback(data);
                    }
                } else {
                    reject(data);
                }
            }).on('error', function (err) { reject(err.message) });
        });
    },

    isExpired: function() {
        // Expressed in ms ( 10 seconds )
        var THRESHOLD = 60000;
        return new Date().getTime() > (this.authorizationExpireTime - THRESHOLD);
    },

    /**
     * Populates the SDK object with the services
     */
    _servicesLoader: function() {
        var self = this;
        // Retrieve all services and add them to this object
        // ex: services.User becomes mangopay.Users
        Object.keys(apiServices).forEach(function (serviceName) {
            var ServiceClass = apiServices[serviceName];
            self[serviceName] = new ServiceClass();
            self[serviceName]._api = self;
        });

        // Retrieve all models and add them to this object
        // ex: models.User becomes mangopay.models.User
        self.models = {};
        Object.keys(apiModels).forEach(function (modelName) {
            self.models[modelName] = apiModels[modelName]
        });
    }
};

function setRateLimits(self, headers) {
    if (self.rateLimits === undefined || self.rateLimits.length === 0) {
        self.rateLimits = [
            {
                minutesInterval: 15,
                callsMade: 0,
                callsRemaining: 0,
                resetTimeMillis: 0
            },
            {
                minutesInterval: 30,
                callsMade: 0,
                callsRemaining: 0,
                resetTimeMillis: 0
            },
            {
                minutesInterval: 60,
                callsMade: 0,
                callsRemaining: 0,
                resetTimeMillis: 0
            },
            {
                minutesInterval: 24 * 60,
                callsMade: 0,
                callsRemaining: 0,
                resetTimeMillis: 0
            }
        ];
    }

    if (headers !== undefined) {
        try {
            if (headers['x-ratelimit'] !== undefined && headers['x-ratelimit'].split(', ').length > 0) {
                const rateLimit = headers['x-ratelimit'].split(', ').map(Number);
                self.rateLimits[0].callsMade = rateLimit[0];
                self.rateLimits[1].callsMade = rateLimit[1];
                self.rateLimits[2].callsMade = rateLimit[2];
                self.rateLimits[3].callsMade = rateLimit[3];
            }

            if (headers['x-ratelimit-remaining'] !== undefined && headers['x-ratelimit-remaining'].split(', ').length > 0) {
                const remaining = headers['x-ratelimit-remaining'].split(', ').map(Number);
                self.rateLimits[0].callsRemaining = remaining[0];
                self.rateLimits[1].callsRemaining = remaining[1];
                self.rateLimits[2].callsRemaining = remaining[2];
                self.rateLimits[3].callsRemaining = remaining[3];
            }

            if (headers['x-ratelimit-reset'] !== undefined && headers['x-ratelimit-reset'].split(', ').length > 0) {
                const limitReset = headers['x-ratelimit-reset'].split(', ').map(Number);
                self.rateLimits[0].resetTimeMillis = limitReset[0];
                self.rateLimits[1].resetTimeMillis = limitReset[1];
                self.rateLimits[2].resetTimeMillis = limitReset[2];
                self.rateLimits[3].resetTimeMillis = limitReset[3];
            }
        } catch (exception) {
            console.log("Something went wrong while parsing rate limits.");
        }
    }
}

module.exports = Api;
