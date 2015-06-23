(function(global) {
  'use strict';

  var R = typeof exports === 'object' ?
    module.require('ramda') :
    global.R;

  // Actual field names are kept short to reduce space overhead in localStorage.
  var fLAST_UPDATE_TIME = 't';
  var fVALUE = 'v';

  var nibelung = {
    Hoard: Hoard
  };

  var __eventSinks = {};

  function Hoard(options) {
    var namespace = options.namespace;
    var ttlMilliseconds = options.ttlMilliseconds;
    var maxRecords = options.maxRecords;
    var _cache = _createStorageInstance(options.persistent);
    var _clock = options.clock || new DefaultClock();
    var _reentrancyProtector = options.reentrancyProtector || new DefaultReentrancyProtector();
    var _logger = options.logger;

    __eventSinks[namespace] = __eventSinks[namespace] || new EventSink([
      'PUT', 'REMOVE', 'CLEAR'
    ]);

    var _getRecordsByLastUpdateTime = R.pipe(
      R.keys,
      R.filter(_isKeyInNamespace),
      R.map(_getRecord),
      R.reject(R.eq(undefined)),
      R.sortBy(R.prop(fLAST_UPDATE_TIME)),
      R.reverse);

    var _getKeysByLastUpdateTime = R.pipe(
      R.keys,
      R.filter(_isKeyInNamespace),
      R.map(_getKeyRecordPair),
      R.reject(R.propEq('r', undefined)),
      R.sortBy(R.path(['r', fLAST_UPDATE_TIME])),
      R.reverse,
      R.pluck('k'));

    var _getRecordsByKey = R.pipe(
      R.map(_wrapKey),
      R.map(_getRecord),
      R.reject(R.eq(undefined)));

    this.getOne = function getOne(key) {
      return this.get([key])[0];
    };

    this.putOne = function putOne(key, value) {
      _put(key, value);
    };

    this.removeOne = function deleteOne(key) {
      this.remove([key]);
    };

    this.get = function get(keys) {
      return R.map(
        _unwrapValue,
        _getRecordsByKey(keys));
    };

    this.put = function put(values, keyName) {
      R.forEach(function (value) {
        _put(value[keyName], value);
      }, values);

      _enforceMaxRecords();
    };

    this.remove = function remove(keys) {
      R.forEach(function(key) {
        _dropRecord(key);
      }, keys);
    }

    /** Filters the keys by what's not already cached. */
    this.excludes = function excludes(keys) {
      return R.reject(_keyExists, keys);
    };

    /**
     * Gets the newest records in the cache, up to limit, in descending
     * order by last update time.
     */
    this.getLatest = function getLatest(limit) {
      var computeLatest = R.pipe(
        _getRecordsByLastUpdateTime,
        R.slice(0, limit),
        R.map(R.prop(fVALUE)));

      return computeLatest(_cache);
    };

    this.clear = function clear() {
      _cache.clear();
      _cache = _createStorageInstance(options.persistent);
      __eventSinks[namespace].emit('CLEAR', undefined, _reentrancyProtector);
    };

    this.on = function on(event, handler) {
      __eventSinks[namespace].on(event, handler);
    };

    this.off = function off(event, handler) {
      __eventSinks[namespace].off(event, handler);
    };

    function _wrapKey(key) {
      return [namespace, key].join('');
    }

    function _unwrapKey(key) {
      return key.replace(namespace, '');
    }

    function _wrapValue(key, value) {
      var record = {};
      record[fVALUE] = value;
      record[fLAST_UPDATE_TIME] = _clock.now();
      return JSON.stringify(record);
    }

    function _unwrapValue(record) {
      if (record) {
        return record[fVALUE];
      }

      return undefined;
    }

    function _isKeyInNamespace(key) {
      return key && key.indexOf(namespace) === 0;
    }

    function _getRecord(cacheKey) {
      var json = _cache[cacheKey];
      if (!json) {
        return undefined;
      }

      var record = JSON.parse(json);

      if (record && _isRecordExpired(record)) {
        _dropRecord(_unwrapKey(cacheKey));
        return undefined;
      }

      return record;
    }

    function  _getKeyRecordPair(cacheKey) {
      return {
        k: _unwrapKey(cacheKey),
        r: _getRecord(cacheKey)
      };
    }

    function _enforceMaxRecords() {
      if (!maxRecords) {
        return;
      }

      var allKeys = _getKeysByLastUpdateTime(_cache);
      var keysOverCap = R.slice(maxRecords, allKeys.length)(allKeys);
      _dropRecords(keysOverCap);
    }

    function _dropRecords(keys) {
      keys.forEach(_dropRecord);
    }

    function _isRecordExpired(record) {
      if (!ttlMilliseconds) {
        return false;
      }

      return _clock.now() - record[fLAST_UPDATE_TIME] >
        ttlMilliseconds;
    }

    function _dropRecord(key) {
      if (!_keyExists(key)) {
        return;
      }

      var cacheKey = _wrapKey(key);
      _cache.removeItem(cacheKey);
      __eventSinks[namespace].emit(
        'REMOVE',
        key,
        _reentrancyProtector);
    }

    function _put(key, value) {
      var cacheKey = _wrapKey(key);
      _cache[cacheKey] = _wrapValue(cacheKey, value);
      __eventSinks[namespace].emit('PUT', value, _reentrancyProtector);
    }

    function _keyExists(key) {
      var cacheKey = _wrapKey(key);
      return _cache.hasOwnProperty(cacheKey);
    }

    function _createStorageInstance(persistent) {
      try {
        var storage = persistent ? window.localStorage : window.sessionStorage;

        // Test that we can actually use the storage:
        storage.setItem('test', true);
        return storage;
      }
      catch (e) {
        _log('Unable to create storage, falling back to in-memory data: ' + e);
        return {
          clear: function () {},
          removeItem: function (key) {
            this[key] = undefined;
          }
        };
      }
    }

    function _log(message) {
      if (!_logger) {
        return;
      }

      _logger(
        ['[' + options.namespace + ']',
        (options.persistent ? '[persistent]' : ''),
        message].join(' '));
    }
  }

  function DefaultClock() {
    this.now = function() {
      return Date.now();
    }
  }

  // Protects emit calls against re-entrancy and exception-prone handlers.
  function DefaultReentrancyProtector() {
    this.protect = function(fn) {
      return window.setTimeout(fn, 0);
    }
  }

  function EventSink(legalEvents) {
    var _handlers = {};
    var _legalEvents = [].concat(legalEvents); // Defensive copy.

    this.on = function on(event, handler) {
      _assertLegalEvent(event);

      if (!_handlers[event]) {
        _handlers[event] = [];
      }

      _handlers[event].push(handler);
    }

    this.off = function off(event, handler) {
      _assertLegalEvent(event);

      if (_handlers[event]) {
        _handlers[event] = R.reject(R.eq(handler), _handlers[event]);
      }
    }

    this.emit = function emit(event, data, reentrancyProtector) {
      _assertLegalEvent(event);
      if (!_handlers[event] || !_handlers[event].length) {
        return;
      }

      R.forEach(function _handle(handler) {
        reentrancyProtector.protect(function () {
          handler(event, data);
        }, 0);
      }, _handlers[event]);
    }

    function _assertLegalEvent(event) {
      if (!R.contains(event, _legalEvents)) {
        throw new Error('Invalid event: ' + event);
      }
    }
  }

  if (typeof exports === 'object') {
     module.exports = nibelung;
   } else if (typeof define === 'function' && define.amd) {
     define(function() { return nibelung; });
   } else {
     global.nibelung = nibelung;
   }
})(this);
