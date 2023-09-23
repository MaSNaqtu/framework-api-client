const CDLI = require('./client')

module.exports.getClient = async function (options) {
    const client = new CDLI.Client(options.host)
    client.on('log', msg => process.stderr.write(msg))

    return client
}
