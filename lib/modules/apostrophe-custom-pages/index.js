var _ = require('lodash');

module.exports = {
  afterConstruct: function(self) {
    // inherit some useful methods from the default manager for our doc type,
    // if we never bothered to override them
    self.manager = self.apos.docs.getManager(self.options.name);
    _.defaults(self, self.manager);
    // now make ourselves the manager
    self.apos.docs.setManager(self.options.name, self);
  },
  construct: function(self, options) {
    self.name = self.options.name || self.__meta.name.replace(/\-pages$/, '');
    // require('./lib/routes.js')(self, options);
    require('./lib/dispatch.js')(self, options);
    // require('./lib/api.js')(self, options);
  }
};