const Router = require('@koa/router');
const Koa = require('koa');
const { version } = require('../package.json');
const bodyParser = require('koa-body');
const errorHandler = require('./utils/middleware/error-handler');
const corsMiddleware = require('./utils/middleware/cors');
const recordMiddleware = require('./utils/middleware/record');
const serializeMiddleware = require('./utils/middleware/serialize');
const { applicationMiddleware } = require('./utils/middleware/application');
const Sentry = require('@sentry/node');
const routes = require('./routes');
const config = require('@bedrockio/config');
const logger = require('@bedrockio/logger');

const app = new Koa();

const ENV_NAME = config.get('ENV_NAME');

app.use(corsMiddleware());
app.use(serializeMiddleware);

// Record middleware must be placed after serialization
// to derive model names but before errorHandler to capture
// error responses.
if (['development'].includes(ENV_NAME)) {
  app.use(recordMiddleware);
}

app.use(errorHandler);

if (['staging', 'development'].includes(ENV_NAME)) {
  // has to be the added before any middleware that changes the ctx.body
  app.use(
    applicationMiddleware({
      ignorePaths: ['/', '/1/status', '/1/status/mongodb', /\/1\/applications/, /\/1\/uploads\/[a-f0-9]{24}\/raw$/],
    })
  );
}

app.use(logger.middleware()).use(bodyParser({ multipart: true }));

app.on('error', (err, ctx) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    // When streaming media, clients may arbitrarily close the
    // connection causing these errors when writing to the stream.
    return;
  }
  // dont output stacktraces of errors that is throw with status as they are known
  if (!err.status || err.status >= 500) {
    logger.error(err);
    Sentry.withScope(function (scope) {
      scope.addEventProcessor(function (event) {
        return Sentry.addRequestDataToEvent(event, ctx.request, {
          include: {
            user: false,
          },
        });
      });
      Sentry.captureException(err);
    });
  }
});

if (config.has('SENTRY_DSN')) {
  Sentry.init({
    dsn: config.get('SENTRY_DSN'),
    environment: ENV_NAME,
  });
}

const router = new Router();

router.get('/', (ctx) => {
  ctx.body = {
    version,
    environment: ENV_NAME,
    // TODO: what should this be?
    // openapiPath: '/openapi.json',
    servedAt: new Date(),
  };
});
router.use(routes);

app.use(router.routes());
app.use(router.allowedMethods());

module.exports = app;
