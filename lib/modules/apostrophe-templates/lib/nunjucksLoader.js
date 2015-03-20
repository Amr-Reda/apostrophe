// This is a nunjucks filesystem loader that allows absolute paths,
// and also allows templates in other modules to be accessed, for
// instance:
//
// apostrophe-templates:outerLayout.html
//
// Note that if apostrophe-templates has a project-level override
// of outerLayout.html, that will be loaded instead. This is
// intentional.
//
// The third argument is a reference to the apostrophe-templates
// module, which constructs this loader once for each module
// that loads templates.

var fs = require('fs');
var path = require('path');
var _ = require('lodash');

module.exports = function(searchPaths, noWatch, templates) {
  var self = this;
  self.templates = templates;
  self.init = function(searchPaths, noWatch) {
    self.pathsToNames = {};
    if (searchPaths) {
      searchPaths = Array.isArray(searchPaths) ? searchPaths : [ searchPaths ];
      // For windows, convert to forward slashes
      self.searchPaths = _.map(searchPaths, path.normalize);
    }
    else {
      self.searchPaths = [];
    }
    if (!noWatch) {
      // Watch all the templates in the paths and fire an event when
      // they change
      _.each(self.searchPaths, function(p) {
        if (fs.existsSync(p)) {
          fs.watch(p, { persistent: false }, function(event, filename) {
            if (!filename) {
              return;
            }
            var fullname = path.join(p, filename);
            if (event === 'change' && fullname in self.pathsToNames) {
              self.emit('update', self.pathsToNames[fullname]);
            }
          });
        }
      });
    }
  };

  self.getSource = function(name) {
    var fullpath = null;

    // Access to templates in other modules.
    //
    // The canonical form is:
    //
    // modulename:pathname
    //
    // However, the fixup logic that allows module-relative
    // paths to work inside templates that are themselves
    // loaded via this feature will result in multiple
    // module paths if an include *does* specify a module.
    // So we apply a simple rule: only the last module
    // path matters

    var moduleName;
    var modulePath;
    while (true) {
      var matches = name.match(/^([\w\-]{2,})\:(.+)$/);
      if (!matches) {
        modulePath = name;
        break;
      }
      moduleName = matches[1];
      name = matches[2];
    }

    if (moduleName) {
      var dirs = self.templates.getViewFolders(self.templates.apos.modules[moduleName]);

      var result;

      var i = 0;
      while (i < dirs.length) {
        var fullpath = dirs[i] + '/' + modulePath;
        if (fs.existsSync(fullpath)) {
          self.pathsToNames[fullpath] = name;
          var src = fs.readFileSync(fullpath, 'utf-8');

          src = self.resolveTemplatePathsViaModule(src, moduleName);

          return { src: src, path: fullpath };
        }
        i++;
      }
      return null;
    }

    _.find(self.searchPaths, function(searchPath) {
      var p = path.join(searchPath, name);
      if (fs.existsSync(p)) {
        fullpath = p;
        return true;
      }
    });
    if (!fullpath) {
      return null;
    }

    self.pathsToNames[fullpath] = name;

    return { src: fs.readFileSync(fullpath, 'utf-8'), path: fullpath };
  };

  // Fix all calls to extend, include and import so that
  // paths without an explicit module name use the specified
  // module name. Uses the official Nunjucks lexer. -Tom

  self.resolveTemplatePathsViaModule = function(src, moduleName) {
    var out = '';
    var lexer = templates.nunjucks.lexer.lex(src);
    var token;
    var state = 'boring';
    while (token = lexer.nextToken()) {
      // Push the token back out again. Unfortunately
      // there is no .raw property, so we have to quote
      // strings and regexes again ourselves (and hope
      // there's nothing else weird out there...)
      if (token.type === 'string') {
        out += '"' + token.value.replace(/\"/g, '\\\"') + '"';
      } else if (token.type === 'regex') {
        out += '/' + token.value.replace(/\//g, '\\/') + '/';
      } else {
        out += token.value;
      }
      if (token.type === 'block-start') {
        state = 'block';
      } else if ((token.type === 'symbol') && (_.contains([ 'include', 'import', 'extends', 'from' ], token.value))) {
        state = 'expr';
        // This is naive and can introduce additional module names
        // if the path here in the template already has a module name.
        // This is worked around explicitly in getSource(). -Tom
        out += ' "' + moduleName + ':" +';
        state = 'boring';
      } else if (token.type === 'block-end') {
        state = 'boring';
      }
    }

    return out;
  };

  self.on = function(name, func) {
    self.listeners = self.listeners || {};
    self.listeners[name] = self.listeners[name] || [];
    self.listeners[name].push(func);
  };

  self.emit = function(name /*, arg1, arg2, ...*/) {
    var args = Array.prototype.slice.call(arguments, 1);

    if (self.listeners && self.listeners[name]) {
      _.each(self.listeners[name], function(listener) {
        listener.apply(null, args);
      });
    }
  };

  self.init(searchPaths, noWatch);
};
