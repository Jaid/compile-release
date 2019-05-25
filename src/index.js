import path from "path"
import fs from "fs"

import yargs from "yargs"
import fsp from "@absolunet/fsp"
import {noop} from "lodash"
import globby from "globby"
import archiver from "archiver"
import {exec} from "pkg"
import promiseSequence from "promise-sequence"

import {log} from "./logger"

const job = async argv => {
  const packageFolder = process.cwd()
  const buildFolder = path.join(packageFolder, "dist", "package", "production")
  const buildFolderExists = await fsp.pathExists(buildFolder)
  if (!buildFolderExists) {
    log(`Build folder ${buildFolder} not found`)
    process.exit(1)
  }
  const packageJsonFile = path.join(buildFolder, "package.json")
  const packageJsonFileExists = await fsp.pathExists(packageJsonFile)
  if (!packageJsonFileExists) {
    log(`${packageJsonFile} not found`)
    process.exit(1)
  }
  const pkg = await fsp.readJson(packageJsonFile)
  const packageId = `${pkg.name}_v${pkg.version}`
  const getMode = async () => {
    for (const knownMode of ["index", "cli", "app"]) {
      const exists = await fsp.pathExists(path.join(buildFolder, `${knownMode}.js`))
      if (exists) {
        log("Mode: %s", knownMode)
        return knownMode
      }
    }
    log("No mode determined")
  }
  const mode = await getMode()
  const releaseFolder = path.join(packageFolder, "dist", "github")
  const [copyList, miniArchiveList] = await Promise.all([
    globby(["readme.*", "*.d.ts", "package.json", "license.*", "thirdPartyLicenses.*"], {
      cwd: buildFolder,
      case: false,
      onlyFiles: true,
    }),
    globby(["*.{ts,js,jsx}", "package.json", "license.*", "thirdPartyLicenses.*"], {
      cwd: buildFolder,
      case: false,
      onlyFiles: true,
    }),
    fsp.mkdirp(releaseFolder),
  ])
  await fsp.emptyDir(releaseFolder)
  const releaseTasks = []
  for (const file of copyList) {
    const from = path.join(buildFolder, file)
    const to = path.join(releaseFolder, file)
    releaseTasks.push(fsp.copy(from, to))
  }
  const fullArchive = archiver("zip", {level: 9})
  fullArchive.directory(buildFolder, false)
  fullArchive.pipe(path.join(releaseFolder, `${packageId}.zip`) |> fs.createWriteStream)
  releaseTasks.push(fullArchive.finalize())
  const miniArchive = archiver("zip", {level: 9})
  for (const file of miniArchiveList) {
    miniArchive.file(path.join(buildFolder, file), {name: file})
  }
  miniArchive.pipe(path.join(releaseFolder, `${packageId}_min.zip`) |> fs.createWriteStream)
  releaseTasks.push(miniArchive.finalize())
  if (mode === "cli" || mode === "app") {
    const pkgOptions = [
      path.join(buildFolder, `${mode}.js`),
      "--config",
      path.join(buildFolder, "package.json"),
      "--options",
      "max_old_space_size=4000",
      "--public",
    ]
    const targets = [
      {
        id: "latest-win-x64",
        file: `${packageId}_windows_x64`,
      },
      {
        id: "latest-macos-x64",
        file: `${packageId}_mac_x64`,
      },
      {
        id: "latest-linux-x64",
        file: `${packageId}_linux_x64`,
      },
      {
        id: "latest-alpine-x64",
        file: `${packageId}_alpine_x64`,
      },
    ]
    const createExecutables = promiseSequence(targets.map(({id, file}) => () => exec([...pkgOptions, "--target", id, "--output", path.join(releaseFolder, file)])))
    releaseTasks.push(createExecutables)
  }
  await Promise.all(releaseTasks)
}

yargs.command("$0", "Creates some release files", noop, job).argv