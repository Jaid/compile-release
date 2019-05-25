import {createLogger, format, transports} from "winston"

const logger = createLogger({
  level: "debug",
  transports: [
    new (transports.Console)({
      format: format.combine(format.splat(), format.cli()),
    }),
    // new (winston.transports.File)({
    //   filename: path.resolve(configDir, "log.txt"),
    //   json: false,
    //   formatter: options => `[${moment().format("DD.MM.YYYY hh:mm:ss")} ${lodash.padStart(options.level.toUpperCase(), 7)}] ${options.message || ""}${options.meta && Object.keys(options.meta).length ? ` ${JSON.stringify(options.meta)}` : ""}`
    // })
  ],
})

export default logger

export const log = logger.info