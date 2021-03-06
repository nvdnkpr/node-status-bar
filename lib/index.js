"use strict";

var util = require ("util");
var stream = require ("stream");
var pbf = require ("progress-bar-formatter");

module.exports.create = function (options){
  return new StatusBar (options);
};

var storage = [" B  ", " KiB", " MiB", " GiB", " TiB", " PiB", " EiB", " ZiB",
    " YiB"];
var speeds = ["B/s", "K/s", "M/s", "G/s", "T/s", "P/s", "E/s", "Z/s", "Y/s"];

var space = function (n, max){
  n += "";
  var spaces = max - n.length;
  for (var i=0; i<spaces; i++){
    n = " " + n;
  }
  return n;
};

var unit = function (n, arr, pow, decimals){
  var chars = decimals ? 5 + decimals : 4;
  if (n < pow) return space (n, chars) + arr[0];
  var i = 1;
  while (i < 9){
    n /= pow;
    if (n < pow) return space (n.toFixed (decimals), chars) + arr[i];
    i++;
  }
  return ">=" + pow + arr[7];
};

var zero = function (n){
  return n < 10 ? "0" + n : n;
};

var Formatter = function (statusBar){
  this._statusBar = statusBar;
};

Formatter.prototype.storage = function (b, decimals){
  return unit (~~b, storage, 1024, decimals === undefined ? 1 : decimals);
};

Formatter.prototype.speed = function (bps, decimals){
  return unit (~~bps, speeds, 1000, decimals === undefined ? 1 : decimals);
};

Formatter.prototype.time = function (s){
  if (s === undefined) return "--:--";
  if (s >= 86400000) return " > 1d";
  if (s >= 3600000) return " > 1h";
  var str;
  var min = ~~(s/60);
  var sec = ~~(s%60);
  return zero (min) + ":" + zero (sec);
};

Formatter.prototype.percentage = function (n){
  return space (Math.round (n*100) + "%", 4);
};

Formatter.prototype.progressBar = function (n){
  return this._statusBar._progress.format (n);
};

var StatusBar = function (options){
  if (options.total === undefined || options.total === null){
    throw new Error ("Missing file size");
  }
  if (!options.render){
    throw new Error ("Missing rendering function");
  }
  
  stream.Writable.call (this);
  
  this.format = new Formatter (this);
  
  var me = this;
  this.on ("unpipe", function (){
    me.cancel ();
  });
  
  this._render = options.render;
  this._frequency = options.frequency || 200;
  this._finish = options.finish;
  this._progress = pbf.create ({
    complete: options.progressBarComplete,
    incomplete: options.progressBarIncomplete,
    length: options.progressBarLength
  });
  this._current = 0;
  this._total = ~~options.total;
  this._renderTimer = null;
  this._elapsedTimer = null;
  this._start = 0;
  this._chunkTimestamp = 0;
  this._smooth = 0.005;
  this._secondsWithoutUpdate = 0;
  
  this._stats = {
    currentSize: 0,
    totalSize: this._total,
    remainingSize: this._total,
    speed: 0,
    elapsedTime: 0
  };
  
  var percentage;
  if (this._total === 0){
    percentage = 1;
    this._stats.remainingTime = 0;
  }else{
    percentage = 0;
    //Undefined remainingTime
  }
  this._stats.percentage = percentage;
  
  //Render for the first time
  this._render.call (this, this._stats);
  
  if (this._frequency && this._total > 0){
    //If the file has a size of 0 the update function is never called and the
    //bar is never rendered again, so there's no need to create a timer
    this._renderTimer = setInterval (function (){
      me._render.call (me, me._stats);
    }, this._frequency);
  }
};

util.inherits (StatusBar, stream.Writable);

StatusBar.prototype._write = function (chunk, encoding, cb){
  this.update (chunk);
  cb ();
};

StatusBar.prototype._updateStats = function (length){
  var end = this._current === this._total;
  var elapsed;
  
  //The elapsed time needs to be calculated with a timer because if it's
  //calculated using the elapsed time from the start of the transfer, if the
  //transfer is hung up, the stat must continue to be updated each second
  if (!this._elapsedTimer){
    var me = this;
    this._elapsedTimer = setInterval (function (){
      //Wait 3 seconds before considering a transfer hang up
      if (++me._secondsWithoutUpdate === 3){
        me._stats.speed = 0;
        me._stats.remainingTime = undefined;
      }
      me._stats.elapsedTime++;
    }, 1000);
  }
  
  this._stats.currentSize = this._current;
  this._stats.remainingSize = this._total - this._current;
  this._stats.percentage = this._current/this._total;
  
  //The speed and remaining time cannot be calculated only with the first packet
  if (this._chunkTimestamp){
    //The transfer speed is extrapolated from the time between chunks
    elapsed = process.hrtime (this._chunkTimestamp);
    //Elapsed in nanoseconds
    elapsed = elapsed[0]*1e9 + elapsed[1];
    
    if (end){
      this._stats.speed = 0;
    }else{
      //Bytes per second
      var lastSpeed = (length*1e9)/elapsed;
      this._stats.speed = ~~(this._smooth*lastSpeed +
          (1 - this._smooth)*(this._stats.speed || lastSpeed));
    }
    
    if (end){
      this._stats.remainingTime = 0;
    }else{
      elapsed = Date.now () - this._start;
      this._stats.remainingTime =
          ~~((0.001*elapsed*this._stats.remainingSize)/this._current) + 1;
    }
  }
};

StatusBar.prototype.cancel = function (){
  clearInterval (this._renderTimer);
  clearInterval (this._elapsedTimer);
};

StatusBar.prototype.update = function (chunk){
  if (!this._start) this._start = Date.now ();
  
  this._secondsWithoutUpdate = 0;
  
  //Allow any object with a length property
  var length = chunk.length || chunk;
  this._current += length;
  
  this._updateStats (length);
  
  //High resolution timer between packets
  this._chunkTimestamp = process.hrtime ();
  
  //Force a render if the transfer has finished
  if (this._current === this._total){
    this.cancel ();
    this._render.call (this, this._stats);
    if (this._finish) this._finish ();
  }
};