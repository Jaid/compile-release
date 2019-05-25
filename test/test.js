import path from "path"

import coffee from "coffee"

const main = path.resolve(process.env.MAIN)

it("should run internal command", () => coffee.fork(main)
  .expect("code", 0)
  .debug()
  .end(), 1000 * 60 * 2)