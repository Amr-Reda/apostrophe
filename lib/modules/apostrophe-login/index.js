// Enable users to log in via a login form on the site at `/login`.
//
// ## Options
//
// `localLogin`
//
// If explicitly set to `false`, the `/login` route does not exist,
// and it is not possible to log in via your username and password.
// This usually makes sense only in the presence of an alternative such as
// the `apostrophe-passport` module, which adds support for login via
// Google, Twitter, gitlab, etc.
//
// `passwordMinLength`
//
// The minimum length for passwords. You should set this, as there
// is no default for bc reasons (effectively the default is `1`).
//
// `passwordRules`
//
// An optional array of password rule names, as strings. The standard rules
// available are `noSlashes`, `noSpaces`, `mixedCase`, `digits`, and
// `noTripleRepeats`. The `noTripleRepeats` rule forbids repeating a
// character three times in a row. By default no rules are in effect.
//
// When this option is set, the rules are consulted when a password
// is set or reset. Existing passwords that do not follow the rules
// are tolerated. If you wish to enforce them for existing passwords
// as well, see below.
//
// `passwordRulesAtLoginTime`
//
// By default, password rules are enforced only when a password is
// being set or reset. If you wish, you can set `passwordRulesAtLoginTime: true`
// to apply them at login time so that even an existing password will
// not work unless it passes the rules. This can be useful if you don't
// mind a few irritated users and you have the `passwordReset` option
// properly configured (see below).
//
// `passwordReset`
//
// If set to `true`, the user is given the option to reset their password,
// provided they can receive a confirmation email. Not available if `localLogin` is `false`.
//
// `passwordResetHours`
//
// When `passwordReset` is `true`, this option controls how many hours
// a password reset request remains valid. If the confirmation email is not
// acted upon in time, the user must request a password reset again.
// The default is `48`.
//
// ## Notable properties of apos.modules['apostrophe-login']
//
// `passport`
//
// Apostrophe's instance of the [passport](https://npmjs.org/package/passport) npm module.
// You may access this object if you need to implement additional passport "strategies."
//
// ## callAll method: loginAfterLogin
//
// The method `loginAfterLogin` is invoked on **all modules that have one**. This method
// is a good place to set `req.redirect` to the URL of your choice. If no module sets
// `req.redirect`, the newly logged-in user is redirected to the home page. `loginAfterLogin`
// is invoked with `req` and may also optionally take a callback.

var Passport = require('passport').Passport;
var LocalStrategy = require('passport-local');
var _ = require('@sailshq/lodash');
var qs = require('qs');
var Promise = require('bluebird');

module.exports = {

  alias: 'login',

  singletonWarningIfNot: 'apostrophe-login',

  afterConstruct: function(self) {
    self.enableSerializeUsers();
    self.enableDeserializeUsers();
    if (self.options.localLogin !== false) {
      self.enableLocalStrategy();
    }
    self.enableMiddleware();
    self.addRoutes();
    self.pushAssets();
    self.addAdminBarItems();
  },

  construct: function(self, options) {

    self.passport = new Passport();

    // Set the `serializeUser` method of `passport` to serialize the
    // user by storing their user ID in the session.

    self.enableSerializeUsers = function() {
      self.passport.serializeUser(function(user, done) {
        done(null, user._id);
      });
    };

    // Set the `deserializeUser` method of `passport` to
    // deserialize the user by locating the appropriate
    // user via the [apostrophe-users](/modules/apostrophe-users)
    // module. Then invokes the `loginDeserialize` method of
    // every module that has one, passing the `user` object. These
    // methods may optionally take a callback.

    self.enableDeserializeUsers = function() {
      self.passport.deserializeUser(self.deserializeUser);
    };

    // Given a user's `_id`, fetches that user via the login module
    // and, if the user is found, invokes the `loginDeserialize`
    // method of all modules that have one via `callAll`.
    // Then invokes the callback with `(null, user)`.
    //
    // If the user is not found, invokes the callback with
    // `(null, null)` (NOTE: no error in the first argument).
    //
    // If another error occurs, it is passed as the first argument.
    //
    // This method is passed to `passport.deserializeUser`.
    // It is also useful when you wish to load a user exactly
    // as Passport would.

    self.deserializeUser = function(id, callback) {
      var req = self.apos.tasks.getReq();
      return self.apos.users.find(req, { _id: id }).toObject(function(err, user) {
        if (err) {
          return callback(err);
        }
        if (!user) {
          return callback(null, null);
        }
        return self.callAllAndEmit('loginDeserialize', 'deserialize', user, function(err) {
          return callback(err, err ? null : user);
        });
      });
    };

    // On every request, immediately after the user has been fetched,
    // build the `user._permissions` object which has a simple
    // boolean property for each permission the user possesses.
    //
    // Permissions can be obtained either via the group or via the
    // user object itself, although there is currently no interface for
    // adding permissions directly to a user.
    //
    // `admin` implies `edit`, and `edit` implies `guest`. These
    // are populated accordingly.
    //
    // If you have `admin-` rights for any specific content types,
    // you are also granted `guest` and `edit` (create) permissions for other
    // types that are not restricted to admins only.

    self.loginDeserialize = function(user) {
      user._permissions = {};
      _.each(user._groups, function(group) {
        _.each(group.permissions || [], function(permission) {
          user._permissions[permission] = true;
        });
      });
      _.each(user.permissions || [], function(permission) {
        user._permissions[permission] = true;
      });
      // The standard permissions are progressive
      if (user._permissions.admin) {
        user._permissions.edit = true;
      }
      if (user._permissions.edit) {
        user._permissions.guest = true;
      }

      // TODO: make this a deprecated default behavior (sigh)

      // If you are admin- for any type of content, you need to be
      // at least guest to effectively attach media to your content,
      // and the edit permission also makes sense because it does not
      // immediately let you do anything, just makes it easier to see
      // you are a candidate to do things like edit pages if given
      // specific rights to them. Also simplifies outerLayout's logic
      if (_.some(user._permissions, function(val, key) {
        return key.match(/^admin-/);
      })) {
        user._permissions.guest = true;
        user._permissions.edit = true;
      }
    };

    // Adds the "local strategy" (username/email and password login)
    // to Passport. Users are found via the `find` method of the
    // [apostrophe-users](/modules/apostrophe-users) module.
    // Users with the `disabled` property set to true may not log in.
    // Passwords are verified via the `verifyPassword` method of
    // [apostrophe-users](/modules/apostrophe-users), which is
    // powered by the [credential](https://npmjs.org/package/credential) module.

    self.enableLocalStrategy = function() {
      self.passport.use(new LocalStrategy(self.verifyLogin));
    };

    // Verify a login attempt. `username` can be either
    // the username or the email address (both are unique).
    //
    // If a system-level failure occurs, such that we don't
    // know if the user's login should have succeeded,
    // then the first argument to the callback is an error.
    //
    // If the user's login FAILS, the first argument is
    // is `null`, and the second argument is `false` (no user).
    //
    // If the user's login SUCCEEDS, the first argument
    // is `null` and the second argument is the user object.
    //
    // PLEASE NOTE THAT A USER FAILING TO LOG IN
    // **DOES NOT** REPORT AN ERROR as the first callback
    // argument. You MUST check the second argument.
    //
    // The convention is set this way for compatibility
    // with `passport`.

    self.verifyLogin = function(username, password, callback) {
      var req = self.apos.tasks.getReq();
      return self.apos.users.find(req, {
        $or: [
          { username: username },
          { email: username }
        ],
        disabled: { $ne: true }
      }).toObject(function(err, user) {
        if (err) {
          return callback(err);
        }
        if (!user) {
          // Slow down and keep 'em hanging to make brute force attacks less easy
          return setTimeout(function () {
            return callback(null, false);
          }, 1000);
        }
        return self.apos.users.verifyPassword(user, password, function(err) {
          if (err) {
            // Slow down and keep 'em hanging to make brute force attacks less easy
            return setTimeout(function () {
              return callback(null, false);
            }, 1000);
          }
          return callback(err, user);
        });
      });
    };

    // Add Passport's initialize and session middleware.
    // Also add middleware to add the `req.data.user` property.
    // Now works via the expressMiddleware property, allowing
    // control of timing relative to other modules.

    self.enableMiddleware = function() {
      self.expressMiddleware = [
        self.passport.initialize(),
        self.passport.session(),
        self.addUserToData
      ];
    };

    // Add the `/login` route, both GET (show the form) and POST (submit the form).
    // Also add the `/logout` route.

    self.addRoutes = function() {
      if (self.options.localLogin !== false) {
        self.apos.app.get('/login', function(req, res) {
          if (req.user) {
            // User is already logged in, redirect to home page
            return res.redirect('/');
          }
          req.scene = 'user';
          // message is supported as a simple way of delivering all errors
          // but we also provide `errors` for templates that wish to do more
          return self.sendPage(req, 'login', { passwordReset: self.options.passwordReset, message: getMessage(), errors: req.query.errors });
          function getMessage() {
            if (req.query.message) {
              return req.query.message;
            }
            if (req.query.errors && req.query.errors.length) {
              return req.query.errors.join(' ');
            }
          }
        });
        self.apos.app.post('/login',
          function(req, res, next) {
            if (!self.options.passwordRulesAtLoginTime) {
              return next();
            }
            var password = req.body.password;
            var errors = self.checkPasswordRules(req, password);
            if (errors.length) {
              return res.redirect('/login?' + qs.stringify({
                errors: errors,
                // bc
                error: '1'
              }));
            }
            return next();
          },
          self.passport.authenticate('local', {
            // failureFlash does not appear to work properly, let's just
            // use a query parameter
            failureRedirect: '/login?' + qs.stringify({
              message: 'Incorrect login or password',
              // bc
              error: '1'
            })
          }),
          self.afterLogin
        );
      }

      if ((self.options.localLogin !== false) && self.options.passwordReset) {

        self.apos.app.get('/password-reset-request', function(req, res) {
          if (req.user) {
            // User is already logged in, redirect to home page
            return res.redirect('/');
          }
          req.scene = 'user';
          // Gets i18n'd in the template, also bc with what templates that tried to work
          // before certain fixes would expect (this is why we still pass a string and not
          // a flag, and why we call it `message`)
          return self.sendPage(req, 'passwordResetRequest', { error: req.query.error });
        });

        self.apos.app.post('/password-reset-request', function(req, res) {
          var username = self.apos.launder.string(req.body.username);
          if (!username.length) {
            return res.redirect('/password-reset-request?error=missing');
          }
          var clauses = [];
          clauses.push({ username: username });
          clauses.push({ email: username });
          return self.apos.users.find(req, {
            $or: clauses
          }).permission(false).toObject().then(function(user) {
            if (!user) {
              throw 'notfound';
            }
            return self.sendPasswordResetEmail(req, user);
          }).then(function() {
            return res.redirect('/login?' + qs.stringify({ message: 'An email message has been sent to you with instructions to reset your password. Be sure to check your spam folder if you do not see it in the next few minutes.' }));
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect('/password-reset-request?error=error');
          });
        });

        self.apos.app.get('/password-reset', function(req, res) {
          var reset = self.apos.launder.string(req.query.reset);
          var email = self.apos.launder.string(req.query.email);
          if (!reset.length) {
            return res.redirect('/password-reset-request?error=missing');
          }
          req.scene = 'user';
          var adminReq = self.apos.tasks.getReq();
          return self.apos.users.find(adminReq, {
            email: email,
            passwordResetAt: { $gte: new Date(Date.now() - self.getPasswordResetLifetimeInMilliseconds()) }
          }).toObject().then(function(user) {
            if (!user) {
              throw 'notfound';
            }
            return self.sendPage(req, 'passwordReset', { reset: reset, email: email, message: getMessage(), errors: req.query.errors });
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect('/login?message=' + req.__('That reset code was not found. It may have expired. Try resetting again.'));
          });

          function getMessage() {
            if (req.query.message) {
              return req.query.message;
            }
            if (req.query.errors && req.query.errors.length) {
              return req.query.errors.join(' ');
            }
          }
        });

        self.apos.app.post('/password-reset', function(req, res) {
          var reset = self.apos.launder.string(req.body.reset);
          var email = self.apos.launder.string(req.body.email);
          var password = self.apos.launder.string(req.body.password);
          if (!reset.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: [ 'The password reset code is missing from your link. Try resetting your password again.' ],
              email: email,
              reset: reset
            }));
          }
          if (!password.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: [ 'You did not enter a new password.' ],
              email: email,
              reset: reset
            }));
          }
          var errors = self.checkPasswordRules(req, password);
          if (errors.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: errors,
              email: email,
              reset: reset
            }));
          }
          var adminReq = self.apos.tasks.getReq();
          return Promise.try(function() {
            return self.apos.users.find(adminReq, {
              email: email,
              passwordResetAt: { $gte: new Date(Date.now() - self.getPasswordResetLifetimeInMilliseconds()) }
            }).toObject();
          }).then(function(user) {
            if (!user) {
              throw new Error('notfound');
            }
            return self.apos.users.verifySecret(user, 'passwordReset', reset).then(function() {
              return user;
            });
          }).then(function(user) {
            user.password = password;
            delete user.passwordResetAt;
            return self.apos.users.update(adminReq, user);
          }).then(function(user) {
            return self.apos.users.forgetSecret(user, 'passwordReset');
          }).then(function(user) {
            return res.redirect('/login?message=' + req.__('Your password has been reset. Please log in.'));
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect('/password-reset?errors[]=error');
          });
        });

        self.getPasswordResetLifetimeInMilliseconds = function() {
          return 1000 * 60 * 60 * (self.options.passwordResetHours || 48);
        };

      }

      self.apos.app.get('/logout', function(req, res) {
        // Completely destroy the session. req.logout only breaks
        // the association with the user. Our end users expect
        // a more secure logout that leaves no trace.
        return req.session.destroy(function(err) {
          if (err) {
            // Not much more we can do, but it will be apparent to the user
            // that they are still logged in
            self.apos.utils.error(err);
          }
          res.redirect('/');
        });
      });
    };

    // Send a password reset email, with a magic link to a one-time-use
    // form to reset the password, to the given `user`. Returns
    // a promise; when that promise resolves the email has been
    // handed off for delivery (not necessarily received).
    //
    // NOTE: the promise will be rejected if the user has no
    // `email` property to which to send an email.

    self.sendPasswordResetEmail = function(req, user) {
      var site = (req.headers['host'] || '').replace(/:\d+$/, '');
      var url;
      var reset;
      return Promise.try(function() {
        reset = self.apos.utils.generateId();
        user.passwordReset = reset;
        user.passwordResetAt = new Date();
        return self.apos.users.update(req, user, { permissions: false }).then(function() {
          return user;
        });
      }).then(function(user) {
        if (!user.email) {
          throw new Error('no email');
        }
        var parsed = require('url').parse(req.absoluteUrl);
        parsed.pathname = '/password-reset';
        parsed.query = { reset: reset, email: user.email };
        delete parsed.search;
        url = require('url').format(parsed);
        return self.email(req, 'passwordResetEmail', { user: user, url: url, site: site }, {
          to: user.email,
          subject: req.res.__(self.options.passwordResetSubject || ('Your request to reset your password on ' + site))
        });
      });
    };

    // Add the `user` property to `req.data` when a user is logged in.

    self.addUserToData = function(req, res, next) {
      if (req.user) {
        req.data.user = req.user;
        return next();
      } else {
        return next();
      }
    };

    // Push the login stylesheet.

    self.pushAssets = function() {
      self.pushAsset('stylesheet', 'always', { when: 'always' });
    };

    // Add the logout admin bar item.

    self.addAdminBarItems = function() {
      self.apos.adminBar.add(self.__meta.name + '-logout', 'Log Out', null, { last: true, href: '/logout' });
    };

    // Invoked by passport after an authentication strategy succeeds
    // and the user has been logged in. Invokes `loginAfterLogin` on
    // any modules that have one and redirects to `req.redirect` or,
    // if it is not set, to `/`.

    self.afterLogin = function(req, res) {
      return self.callAllAndEmit('loginAfterLogin', 'after', req, function(err) {
        if (err) {
          self.apos.utils.error(err);
          return res.redirect('/');
        }
        req.redirect = req.redirect || '/';
        return res.redirect(req.redirect);
      });
    };

    // Returns an array of error messages, which will be
    // empty if there are no errors. The error messages
    // will be internationalized for you.

    self.checkPasswordRules = function(req, password) {
      var errors = [];
      var minLength = self.options.passwordMinLength || 1;
      if (password.length < minLength) {
        errors.push('Passwords must be at least ' + minLength + ' characters long.');
      }
      if (self.options.passwordRules) {
        _.each(self.options.passwordRules, function(name) {
          var rule = self.passwordRules[name];
          if (!rule.test(password)) {
            errors.push(rule.message);
          }
        });
      }
      errors = errors.map(function(error) {
        return req.__(error);
      });
      return errors;
    };

    self.passwordRules = {
      noSlashes: {
        test: function(password) {
          return !((password.indexOf('/') !== -1) || (password.indexOf('\\') !== -1));
        },
        message: '/ and \\ characters are not allowed in passwords.'
      },
      noSpaces: {
        test: function(password) {
          return !password.match(/\s/);
        },
        message: 'Spaces are not allowed in passwords.'
      },
      mixedCase: {
        test: function(password) {
          return password.match(/[a-z]/) && password.match(/[A-Z]/);
        },
        message: 'Passwords must contain both uppercase and lowercase characters.'
      },
      digits: {
        test: function(password) {
          return password.match(/\d/);
        },
        message: 'Passwords must contain digits.'
      },
      noTripleRepeats: {
        test: function(password) {
          var i;
          for (i = 0; (i < (password.length - 2)); i++) {
            var char0 = password.charAt(i);
            var char1 = password.charAt(i + 1);
            var char2 = password.charAt(i + 2);
            if ((char0 === char1) && (char0 === char2)) {
              return false;
            }
          }
          return true;
        },
        message: 'No character may be repeated three times in a row in a password.'
      }
    };

    // Register a password validation rule. Does not
    // activate it, see the passwordRules option.
    // `name` is a unique name to be included in the
    // `passwordRules` option array, `test` is a function
    // that accepts the password and returns `true` only
    // if the password passes the rule, and `message`
    // is a short message to be shown to the user in the
    // event the rule fails, which will automatically be
    // internationalized for you.

    self.addPasswordRule = function(name, test, message) {
      self.passwordRules[name] = {
        test: test,
        message: message
      };
    };

    self.modulesReady = function() {
      // So this property is hashed and the hash kept in the safe,
      // rather than ever being stored literally
      self.apos.users.addSecret('passwordReset');
    };

  }
};
