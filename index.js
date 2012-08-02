var poolModule = require("generic-pool"),
	path = require("path"),
	log = require("util").log,
	sqlstring = require("./SQLString");

var config = require( path.join(__dirname, "..", "..", "config", "database") );

var pool = poolModule.Pool({
    name     : 'mysql',

    create   : function(callback) {
        var mysql = require('mysql');

		var client = mysql.createClient({
			user: config.user,
			password: config.password,
			host: config.host,
			port: config.port,
		}).on("error", function(err) {
			log("DB ERROR: " + err);
			client = null;
		});

		// switch to target database
		client.useDatabase( config.database ,function(err) {
			if(err) {
				log("DB ERROR: Database cannot select db, detail: " + err);
				return callback(err);
			}

			return callback(null, client);
		});
    },

    destroy  : function(client) { client.end(); },

    max      : 10,
    idleTimeoutMillis : 30000,
    log : false
});

//
// GenericObject Constructor and important startup function
//
var GenericObject = function(table_name) {
	var self = this;

	self._table_name = table_name;
	self._fields = []; 
	self._observer = {};
	self._vaildObserveSubject = ["SELECT", "UPDATE", "CREATE", "REMOVE", "INIT"];

	// collect fields
	self.select( { limit: 1, offset: 0 }, function(err, data, fields) {
		if(err) {
			return log(err);
		}

		self._fields = fields;
	});

	log(table_name + " Accessor instance created");
};

//
// Observer
//
GenericObject.prototype.registerObserver = function(methods, callback) {
	var self = this;

	if (typeof methods === "undefined" || typeof callback === "undefined") {
		return false;
	}

	if(methods.length === 0) {
		return false;
	}

	methods.map(function(method) {
		// skip invaild subject(event)
		if(self._vaildObserveSubject.indexOf(method) === -1) {
			return;
		}

		if(method === "INIT") {
			return callback();
		}

		if(typeof self._observer[method] === "undefined") {
			self._observer[method] = [];
		}
		
		self._observer[method].push(callback);
	});
};

GenericObject.prototype.notify = function(event) {
	var self = this;

	log(event + " called notify");

	if(self._vaildObserveSubject.indexOf(event) === -1) {
		return;
	}

	if(typeof self._observer[event] === "undefined" || !(self._observer[event] instanceof Array) ) {
		return;
	}

	self._observer[event].map(function(observer) {
		process.nextTick(function() {
			observer(event);
		});
	});
};

//
// CRUD action
//
GenericObject.prototype.create = function(dataObject, callback) {
	var self = this;

	// sql building
	var _sql_fieldValues = self._fieldValueBuilder(dataObject);

	var sql = "INSERT INTO " + self._table_name + " SET " + _sql_fieldValues + ";";

	// sql executing
	self._query(sql, function(err, info) {

		self.notify("CREATE");
		
		process.nextTick(function() {
			return callback(err, info);
		});
	});
};

GenericObject.prototype.select = function() {
	var self = this;

	// argument parser
	var callback, options;

	if( typeof arguments[0] === "function" ) {
		callback = arguments[0];
	} else {
		options = arguments[0];
		callback = arguments[1];
	}
	
	// just in case of no option exists
	options = (!options) ? {} : options;

	// building sql
	var _sql_where = self._whereClauseBuilder(options);

	// remaining sql
	var _sql_fields = ( options.fields && Array.isArray(options.fields) ) ? ("`" + options.fields.join("`,`") + "`") : "*";
	var _sql_limit = ( options.limit && parseInt(options.limit) > 0 ) ? " LIMIT " + parseInt(options.limit) : "";
	var _sql_offset = ( options.offset && parseInt(options.offset) > 0 ) ? " OFFSET " + parseInt(options.offset) : "";

	// sql execute
	var sql = "SELECT " + _sql_fields  + " FROM " + self._table_name + _sql_where + _sql_limit + _sql_offset + ";";

	self._query(sql, function(err, dataset, fields) {

		self.notify("SELECT");
		
		process.nextTick(function() {
			return callback(err, dataset, fields);
		});
	});

};

GenericObject.prototype.update = function(options, newDataObject, callback) {
	var self = this;
	
	// sql building
	var _sql_fieldValues = self._fieldValueBuilder(newDataObject),
		_sql_where = self._whereClauseBuilder(options);

	var sql = "UPDATE " + self._table_name + " SET " + _sql_fieldValues + _sql_where + ";";

	// sql executing
	self._query(sql, function(err, info) {

		self.notify("UPDATE");
		
		process.nextTick(function() {
			return callback(err, info);
		});
	});

};

GenericObject.prototype.remove = function(options, callback) {
	var self  = this;

	// sql building
	var _sql_where = self._whereClauseBuilder(options);
	var sql = "DELETE FROM " + self._table_name + _sql_where + ";";
	
	// sql executing
	self._query(sql, function(err, info) {

		self.notify("REMOVE");
		
		process.nextTick(function() {
			return callback(err, info);
		});
	});

};

// 
// Helpers
//
GenericObject.prototype._keys = function (object) {
	var key_list = [],
		key;

	for(key in object) {
		key_list.push(key);
	}

	return key_list;
};

GenericObject.prototype._whereClauseBuilder = function(options) {
	var _sql_where = "";

	if( options.where && Array.isArray(options.where) ) {
		_sql_where = " WHERE";
		options.where.map(function(value) {
			if( Array.isArray(value) ) {
				if ( value.length === 3 ) { // field, opeator, value
					_sql_where += " `" + value[0] + "` " + value[1] + " '" + value[2] + "' ";
				}
			} else {
				_sql_where += " " + value + " ";
			}
		});
	}

	return _sql_where;
};

GenericObject.prototype._fieldValueBuilder = function(dataObject) {
	var field_list = [],
		self = this,
		key;
	
	for(key in dataObject) {
		if(typeof self._fields === "undefined") {
			log( "Warning: Schema fields not found.");
			continue;
		}

		if( self._fields.indexOf(key) === -1 ) {
			log( "Warning: " + key + " is not in database schema, and is not inserted into queryset.");
			continue;
		}

		field_list.push("`" + key + "` = " + sqlstring.escape(dataObject[key]));
	}

	return field_list.join(",");
};

GenericObject.prototype._query = function(sql, callback) {
	var self = this;

	pool.acquire(function(err, db) {
		if(db === null) {
			return callback(new Error("No database connection."));
		}

		db.query(sql, function(err, data, fields) {
			
			if(err) {
				log("ERROR: Database select error, detail: " + err + ", queried: " + sql);
				process.nextTick(function() { callback(err); });
				return;
			}
			
			pool.release(db);
			
			if(typeof fields === "undefined") {
				process.nextTick(function() { callback( null, data ) ; });
			} else {
				process.nextTick(function() { callback( null, data, self._keys(fields) ) ; });
			}
		});
	});
};

//
// Module export
//
module.exports = GenericObject;
