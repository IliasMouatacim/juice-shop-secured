/*
 * Copyright (c) 2014-2025 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { type Request, type Response, type NextFunction } from 'express'

import * as challengeUtils from '../lib/challengeUtils'
import { challenges } from '../data/datacache'
import * as security from '../lib/insecurity'
import { type Review } from 'data/types'
import * as db from '../data/mongodb'
import * as utils from '../lib/utils'

// Blocking sleep function as in native MongoDB
// @ts-expect-error FIXME Type safety broken for global object
global.sleep = (time: number) => {
  // Ensure that users don't accidentally dos their servers for too long
  if (time > 2000) {
    time = 2000
  }
  const stop = new Date().getTime()
  while (new Date().getTime() < stop + time) {
    ;
  }
}

export function showProductReviews () {
  return (req: Request, res: Response, next: NextFunction) => {
    // Truncate id to avoid unintentional RCE
    // Parse and validate the product ID
const productId = parseInt(req.params.id, 10)
if (isNaN(productId)) {
  return res.status(400).json({ error: 'Invalid product id' })
}

// Measure query time (optional, for challenge detection)
const t0 = new Date().getTime()

db.reviewsCollection.find({ product: productId }).then((reviews: Review[]) => {
  const t1 = new Date().getTime()
  challengeUtils.solveIf(challenges.noSqlCommandChallenge, () => { return (t1 - t0) > 1500 })
  const user = security.authenticatedUsers.from(req)
  for (let i = 0; i < reviews.length; i++) {
    if (user === undefined || reviews[i].likedBy.includes(user.data.email)) {
      reviews[i].liked = true
    }
  }
  res.json(utils.queryResultToJson(reviews))
}).catch(() => {
  res.status(400).json({ error: 'Wrong Params' })
})

}} 
