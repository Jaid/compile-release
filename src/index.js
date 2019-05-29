import path from "path"
import fs from "fs"

import yargs from "yargs"
import fsp from "@absolunet/fsp"
import {noop} from "lodash"
import globby from "globby"
import archiver from "archiver"
import {exec} from "pkg"
import promiseSequence from "promise-sequence"
import whichPromise from "which-promise"
import execa from "execa"
import jaidLogger from "jaid-logger"
import stringifyAuthor from "stringify-author"
import moment from "moment"

const logger = jaidLogger(_PKG_TITLE)

const findDpkgDebFile = async () => {
  try {
    return await whichPromise("dpkg-deb")
  } catch {
    return false
  }
}

const job = async argv => {
  const packageFolder = process.cwd()
  const buildFolder = path.join(packageFolder, "dist", "package", "production")
  const buildFolderExists = await fsp.pathExists(buildFolder)
  if (!buildFolderExists) {
    logger.warn(`Build folder ${buildFolder} not found`)
    process.exit(1)
  }
  const packageJsonFile = path.join(buildFolder, "package.json")
  const packageJsonFileExists = await fsp.pathExists(packageJsonFile)
  if (!packageJsonFileExists) {
    logger.warn(`${packageJsonFile} not found`)
    process.exit(1)
  }
  const pkg = await fsp.readJson(packageJsonFile)
  const packageId = `${pkg.name}_v${pkg.version}`
  const getMode = async () => {
    for (const knownMode of ["index", "cli", "app"]) {
      const exists = await fsp.pathExists(path.join(buildFolder, `${knownMode}.js`))
      if (exists) {
        logger.info("Mode: %s", knownMode)
        return knownMode
      }
    }
    logger.warn("No mode determined")
  }
  const mode = await getMode()
  const prodScript = path.join(buildFolder, `${mode}.js`)
  const devScript = path.join(packageFolder, "dist", "package", "development", `${mode}.js`)
  const hasDevelopmentBuild = await fsp.pathExists(devScript)
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
      "--config",
      path.join(buildFolder, "package.json"),
      "--options",
      "max_old_space_size=4000",
      "--public",
    ]
    let targets = [
      {
        id: "latest-win-x64",
        input: prodScript,
        output: `${packageId}_windows_x64`,
      },
      {
        id: "latest-macos-x64",
        input: prodScript,
        output: `${packageId}_mac_x64`,
      },
      {
        id: "latest-linux-x64",
        input: prodScript,
        output: `${packageId}_linux_x64`,
      },
      {
        id: "latest-alpine-x64",
        input: prodScript,
        output: `${packageId}_alpine_x64`,
      },
    ]
    if (hasDevelopmentBuild) {
      targets = [
        {
          id: "latest-win-x64",
          input: devScript,
          output: `${packageId}_debug_windows_x64`,
        },
        {
          id: "latest-macos-x64",
          input: devScript,
          output: `${packageId}_debug_mac_x64`,
        },
        {
          id: "latest-linux-x64",
          input: devScript,
          output: `${packageId}_debug_linux_x64`,
        },
        {
          id: "latest-alpine-x64",
          input: devScript,
          output: `${packageId}_debug_alpine_x64`,
        },
        ...targets,
      ]
    }
    const compileExecutableTasks = targets.map(target => () => exec([...pkgOptions, "--target", target.id, "--output", path.join(releaseFolder, target.output), target.input]))
    releaseTasks.push(compileExecutableTasks |> promiseSequence)
  }
  await Promise.all(releaseTasks)
  if (mode === "cli" || mode === "app") {
    const dpkgDebFile = await findDpkgDebFile()
    if (dpkgDebFile) {
      logger.info("Found dpkg-deb binary at %s", dpkgDebFile)
      const scriptBinaryFile = `${packageId}_linux_x64`
      const debFolder = path.join(packageFolder, "dist", "deb")
      const debBinFolder = path.join(debFolder, "usr", "local", "bin")
      await fsp.ensureDir(debBinFolder)
      const releaseBinFile = path.join(releaseFolder, scriptBinaryFile)
      const debBinFile = path.join(debBinFolder, pkg.name)
      await fsp.copyFile(releaseBinFile, debBinFile)
      logger.info("Copied linux binary %s to %s", releaseBinFile, debBinFile)
      const {size} = await fsp.stat(debBinFile)
      const debInfo = {
        Package: pkg.name,
        Version: pkg.version,
        "Standards-Version": pkg.version,
        Maintainer: pkg.author |> stringifyAuthor,
        Description: pkg.description,
        "Installed-Size": Math.ceil(size / 1024),
        Section: "base",
        Priority: "optional",
        Architecture: "amd64",
        Date: moment().format("ddd, DD MMM YYYY HH:mm:ss ZZ"),
      }
      if (pkg.homepage) {
        debInfo.Homepage = pkg.homepage
      }
      const controlContent = debInfo
        |> Object.entries
        |> #.map(([key, value]) => `${key}: ${value}`)
        |> #.join("\n")
      const controlFile = path.join(debFolder, "DEBIAN", "control")
      logger.info("Wrote %s properties to info file %s", Object.keys(debInfo).length, controlFile)
      await fsp.outputFile(controlFile, `${controlContent}\n`, "utf8")
      await execa(dpkgDebFile, ["--build", debFolder, releaseFolder])
    } else {
      logger.warn("Skipping deb building, dpkg-deb not found")
    }
  }
}

yargs.command("$0", "Creates some release files", noop, job).argv