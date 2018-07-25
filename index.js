const path = require('path')
const {
  hasYarn,
  IpcMessenger,
} = require('@vue/cli-shared-utils')
const chalk = require('chalk')
const { defaultValue, nullable } = require('./utils')

const DEFAULT_SERVER_FOLDER = './apollo-server'
const COMMAND_OPTIONS = {
  '--mock': 'enables mocks',
  '--enable-engine': 'enables Apollo Engine',
  '--delay': 'delays run by a small duration',
  '--port': 'specify server port',
}

let ipc, ipcTimer

module.exports = (api, options) => {
  const cmd = hasYarn() ? 'yarn' : 'npm'
  const useThreads = process.env.NODE_ENV === 'production' && options.parallel
  const cacheDirectory = api.resolve('node_modules/.cache/cache-loader')

  api.chainWebpack(config => {
    const rule = config.module
      .rule('gql')
      .test(/\.(gql|graphql)$/)
      .include
      .add(api.resolve('src'))
      .add(api.resolve('tests'))
      .end()
      .use('cache-loader')
      .loader('cache-loader')
      .options({ cacheDirectory })
      .end()

    if (useThreads) {
      rule
        .use('thread-loader')
        .loader('thread-loader')
    }

    rule
      .use('gql-loader')
      .loader('graphql-tag/loader')
      .end()

    if (api.hasPlugin('eslint') && config.module.rules.has('eslint')) {
      const id = generateCacheIdentifier(api.resolve('.'))

      config.module
        .rule('eslint')
        .test(/\.(vue|(j|t)sx?|gql|graphql)$/)
        .use('eslint-loader')
        .tap(options => ({
          ...options,
          cacheIdentifier: options.cacheIdentifier + id,
        }))
    }
  })

  api.registerCommand('apollo:watch', {
    description: 'Run the Apollo server and watch the sources to restart automatically',
    usage: 'vue-cli-service apollo:watch [options]',
    options: COMMAND_OPTIONS,
    details: 'For more info, see https://github.com/Akryum/vue-cli-plugin-apollo',
  }, args => {
    // Plugin options
    const apolloOptions = nullable(nullable(options.pluginOptions).apollo)
    const baseFolder = defaultValue(apolloOptions.serverFolder, DEFAULT_SERVER_FOLDER)

    const nodemon = require('nodemon')

    // Pass the args along
    let flatArgs = []
    for (const key in COMMAND_OPTIONS) {
      const shortKey = key.substr(2)
      if (args.hasOwnProperty(shortKey)) {
        flatArgs.push(key)
        const value = args[shortKey]
        if (value !== true) {
          flatArgs.push(value)
        }
      }
    }

    return new Promise((resolve, reject) => {
      nodemon({
        exec: `${cmd} run apollo:run --delay ${flatArgs.join(' ')}`,
        watch: [
          api.resolve(baseFolder),
        ],
        ignore: [
          api.resolve(path.join(baseFolder, 'live')),
        ],
        ext: 'js mjs json graphql gql',
      })

      sendIpcMessage({
        error: false,
      })

      nodemon.on('restart', () => {
        console.log(chalk.bold(chalk.green(`⏳  GraphQL API is restarting...`)))

        sendIpcMessage({
          error: false,
        })
      })

      nodemon.on('crash', () => {
        console.log(chalk.bold(chalk.red(`💥  GraphQL API crashed!`)))
        console.log(chalk.red(`   Waiting for changes...`))

        sendIpcMessage({
          urls: null,
          error: true,
        })
      })

      nodemon.on('stdout', (...args) => {
        console.log(chalk.grey(...args))
      })

      nodemon.on('stderr', (...args) => {
        console.log(chalk.grey(...args))
      })

      nodemon.on('quit', () => {
        resolve()
        process.exit()
      })
    })
  })

  api.registerCommand('apollo:run', {
    description: 'Run the Apollo server',
    usage: 'vue-cli-service apollo:run [options]',
    options: COMMAND_OPTIONS,
    details: 'For more info, see https://github.com/Akryum/vue-cli-plugin-apollo',
  }, args => {
    const run = () => {
      let server = require('./graphql-server')
      server = server.default || server

      // Env
      const port = args.port || process.env.VUE_APP_GRAPHQL_PORT || 4000
      process.env.VUE_APP_GRAPHQL_PORT = port
      const graphqlPath = process.env.VUE_APP_GRAPHQL_PATH || '/graphql'
      const subscriptionsPath = process.env.VUE_APP_GRAPHQL_SUBSCRIPTIONS_PATH || '/graphql'
      const engineKey = process.env.VUE_APP_APOLLO_ENGINE_KEY || null

      // Plugin options
      const apolloOptions = nullable(nullable(options.pluginOptions).apollo)
      const baseFolder = defaultValue(apolloOptions.serverFolder, DEFAULT_SERVER_FOLDER)

      const opts = {
        port,
        graphqlPath,
        subscriptionsPath,
        engineKey,
        enableMocks: defaultValue(args.mock, apolloOptions.enableMocks),
        enableEngine: defaultValue(args['enable-engine'], apolloOptions.enableEngine),
        cors: defaultValue(apolloOptions.cors, '*'),
        timeout: defaultValue(apolloOptions.timeout, 120000),
        integratedEngine: defaultValue(apolloOptions.integratedEngine, true),
        serverOptions: apolloOptions.apolloServer,
        paths: {
          typeDefs: api.resolve(`${baseFolder}/type-defs.js`),
          resolvers: api.resolve(`${baseFolder}/resolvers.js`),
          context: api.resolve(`${baseFolder}/context.js`),
          mocks: api.resolve(`${baseFolder}/mocks.js`),
          pubsub: api.resolve(`${baseFolder}/pubsub.js`),
          server: api.resolve(`${baseFolder}/server.js`),
          apollo: api.resolve(`${baseFolder}/apollo.js`),
          engine: api.resolve(`${baseFolder}/engine.js`),
          directives: api.resolve(`${baseFolder}/directives.js`),
        },
      }

      server(opts, () => {
        sendIpcMessage({
          urls: {
            playground: `http://localhost:${port}${graphqlPath}`,
          },
        })
      })
    }

    if (args.delay) {
      setTimeout(run, 300)
    } else {
      run()
    }
  })
}

module.exports.defaultModes = {
  'run-apollo-server': 'development',
}

function generateCacheIdentifier (context) {
  const fs = require('fs')
  const path = require('path')

  const graphqlConfigFile = path.join(context, '.graphqlconfig')
  if (fs.existsSync(graphqlConfigFile)) {
    try {
      const graphqlConfig = JSON.parse(fs.readFileSync(graphqlConfigFile, { encoding: 'utf8' }))
      const schemaFile = path.join(context, graphqlConfig.schemaPath)
      return fs.statSync(schemaFile).mtimeMs
    } catch (e) {
      console.error('Invalid .graphqlconfig file')
    }
  }
}

function sendIpcMessage (message) {
  if (!ipc && IpcMessenger) {
    ipc = new IpcMessenger()
    ipc.connect()
  }
  if (ipc) {
    ipc.send({
      'org.akryum.vue-apollo': message,
    })
    clearTimeout(ipcTimer)
    ipcTimer = setTimeout(() => {
      ipc.disconnect()
      ipc = null
    }, 3000)
  }
}
