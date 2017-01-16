import { readFileSync } from 'fs';
import { format as formatUrl } from 'url';
import httpolyglot from 'httpolyglot';
import url from 'url';
import Hapi from 'hapi';
import Wreck from 'wreck';
import createAgent from './create_agent';
import mapUri from './map_uri';
import getKibanaIndexName from './get_kibana_index_name';
import modifyPayload from './modify_payload';

module.exports = function(kbnServer) {

  const server = new Hapi.Server();

  server.register({
    register: require('kibi-h2o2')
  }, function (err) {
    if (err) {
      kbnServer.log(['plugin:own-home', 'error'], 'Failed to load kibi-h2o2');
    }
  });

  const uri = url.parse(kbnServer.config().get('elasticsearch.url'));
  if (uri.protocol == 'https:') {
    server.connection({
      host: uri.hostname,
      port: uri.port,
      tls: true,
      listener: httpolyglot.createServer({
        key: readFileSync(kbnServer.config().get('own_home.ssl.key')),
        cert: readFileSync(kbnServer.config().get('own_home.ssl.cert')),

        ciphers: [
          'ECDHE-RSA-AES128-GCM-SHA256',
          'ECDHE-ECDSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-ECDSA-AES256-GCM-SHA384',
          'DHE-RSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES128-SHA256',
          'DHE-RSA-AES128-SHA256',
          'ECDHE-RSA-AES256-SHA384',
          'DHE-RSA-AES256-SHA384',
          'ECDHE-RSA-AES256-SHA256',
          'DHE-RSA-AES256-SHA256',
          'HIGH',
          '!aNULL',
          '!eNULL',
          '!EXPORT',
          '!DES',
          '!RC4',
          '!MD5',
          '!PSK',
          '!SRP',
          '!CAMELLIA'
        ].join(':'),
        // We use the server's cipher order rather than the client's to prevent the BEAST attack
        honorCipherOrder: true
      })
    });

    server.ext('onRequest', function (request, reply) {
      if (request.raw.req.socket.encrypted) {
        reply.continue();
      } else {
        reply.redirect(formatUrl({
          port,
          protocol: 'https',
          hostname: host,
          pathname: request.url.pathname,
          search: request.url.search,
        }));
      }
    });
  } else {
    server.connection({
      host: uri.hostname,
      port: uri.port
    });
  }

  server.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    path: '/{paths*}',
    config: {
      timeout: {
        socket: kbnServer.config().get('elasticsearch.requestTimeout')
      }
    },
    handler: {
      kibi_proxy: {
        mapUri: mapUri(kbnServer),
        agent: createAgent(kbnServer),
        xforward: true,
        passThrough: true,
        timeout: kbnServer.config().get('elasticsearch.requestTimeout'),
        modifyPayload: modifyPayload(kbnServer),
        onResponse: function (err, response, request, reply) {
          if (err) {
            reply(err);
            return;
          }

          // Back kibana.index to original one in responce body
          Wreck.read(response, { json: true }, function (err, payload) {
            let replacedIndex = getKibanaIndexName(kbnServer, request);
            if (replacedIndex && payload[replacedIndex]) {
              payload[kbnServer.config().get('kibana.index')] = payload[replacedIndex];
              delete payload[replacedIndex];
            }
            if (replacedIndex && request.path.endsWith('_msearch') && payload['error']) {
              // TODO(wtakase): Scan requested payload and count up number of searches
              const searchNum = 32;
              payload['responses'] = [];
              payload['responses'].push({'error': payload['error'], 'status': payload['status']});
              for (let i = 0; i < searchNum - 1; i++) {
                payload['responses'].push({});
              }
              delete payload['error'];
              delete payload['status'];
            }
            reply(payload);
          });
        }
      }
    }
  });

  server.start((err) => {
    if (err) {
      throw err;
    }
    kbnServer.log(['plugin:own-home', 'info'], 'Proxy server started at ' + server.info.uri);
  });

  const yarOptions = {
    name: 'own-home-session',
    cache: {
      expiresIn: kbnServer.config().get('own_home.session.timeout')
    },
    cookieOptions: {
      password: kbnServer.config().get('own_home.session.secretkey'),
      isSecure: kbnServer.config().get('own_home.session.isSecure'),
      passThrough: true
    }
  };

  kbnServer.register({
    register: require('yar'),
    options: yarOptions
  }, function (err) {
    if (err) {
      kbnServer.log(['plugin:own-home', 'error'], 'Unknown error occured at the init()');
    }
  });

  server.register({
    register: require('yar'),
    options: yarOptions
  }, function (err) {
    if (err) {
      kbnServer.log(['plugin:own-home', 'error'], 'Unknown error occured at the init()');
    }
  });

};
