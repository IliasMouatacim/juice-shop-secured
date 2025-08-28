/*
 * Copyright (c) 2014-2025 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs'
import path from 'node:path'
import config from 'config'
import PDFDocument from 'pdfkit'
import { type Request, type Response, type NextFunction } from 'express'
import { QueryTypes } from 'sequelize'

import { challenges, products } from '../data/datacache'
import * as challengeUtils from '../lib/challengeUtils'
import { BasketItemModel } from '../models/basketitem'
import { DeliveryModel } from '../models/delivery'
import { QuantityModel } from '../models/quantity'
import { ProductModel } from '../models/product'
import { BasketModel } from '../models/basket'
import { WalletModel } from '../models/wallet'
import * as security from '../lib/insecurity'
import * as utils from '../lib/utils'
import * as db from '../data/mongodb'

interface Product {
  quantity: number
  id?: number
  name: string
  price: number
  total: number
  bonus: number
}


export function placeOrder () {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id

      const basket = await BasketModel.findOne({
        where: { id },
        include: [{ model: ProductModel, paranoid: false, as: 'Products' }]
      })

      if (!basket) return next(new Error(`Basket with id=${id} does not exist.`))

      const customer = security.authenticatedUsers.from(req)
      const email = customer ? (customer.data ? customer.data.email : '') : ''
      const orderId = security.hash(email).slice(0, 4) + '-' + utils.randomHexString(16)
      const pdfFile = `order_${orderId}.pdf`
      const doc = new PDFDocument()
      const basketProducts: Product[] = []
      let totalPrice = 0
      let totalPoints = 0

      // Loop over products and update quantities
      for (const { BasketItem, price, deluxePrice, name, id } of basket.Products ?? []) {
        if (!BasketItem) continue

        challengeUtils.solveIf(challenges.christmasSpecialChallenge, () => BasketItem.ProductId === products.christmasSpecial.id)

        const productQty = await QuantityModel.findOne({ where: { ProductId: BasketItem.ProductId } })
        if (productQty) {
          const newQuantity = productQty.quantity - BasketItem.quantity
          await QuantityModel.update({ quantity: newQuantity }, { where: { ProductId: BasketItem.ProductId } })
        }

        const itemPrice = security.isDeluxe(req) ? deluxePrice : price
        const itemTotal = itemPrice * BasketItem.quantity
        const itemBonus = Math.round(itemPrice / 10) * BasketItem.quantity

        const product: Product = {
          quantity: BasketItem.quantity,
          id,
          name: req.__(name),
          price: itemPrice,
          total: itemTotal,
          bonus: itemBonus
        }

        basketProducts.push(product)
        doc.text(`${BasketItem.quantity}x ${req.__(name)} ${req.__('ea.')} ${itemPrice} = ${itemTotal}¤`)
        doc.moveDown()
        totalPrice += itemTotal
        totalPoints += itemBonus
      }

      // Calculate discount, delivery, total price
      const discount = calculateApplicableDiscount(basket, req) ?? 0
      let discountAmount = '0'
      if (discount > 0) {
        discountAmount = (totalPrice * (discount / 100)).toFixed(2)
        doc.text(discount + '% discount from coupon: -' + discountAmount + '¤')
        doc.moveDown()
        totalPrice -= parseFloat(discountAmount)
      }

      const deliveryMethod = { deluxePrice: 0, price: 0, eta: 5 }
      if (req.body.orderDetails?.deliveryMethodId) {
        const deliveryMethodFromModel = await DeliveryModel.findOne({ where: { id: req.body.orderDetails.deliveryMethodId } })
        if (deliveryMethodFromModel) {
          deliveryMethod.deluxePrice = deliveryMethodFromModel.deluxePrice
          deliveryMethod.price = deliveryMethodFromModel.price
          deliveryMethod.eta = deliveryMethodFromModel.eta
        }
      }
      const deliveryAmount = security.isDeluxe(req) ? deliveryMethod.deluxePrice : deliveryMethod.price
      totalPrice += deliveryAmount

      // Handle wallet payment
      if (req.body.UserId && req.body.orderDetails?.paymentId === 'wallet') {
        const wallet = await WalletModel.findOne({ where: { UserId: req.body.UserId } })
        if (!wallet || wallet.balance < totalPrice) return next(new Error('Insufficient wallet balance.'))
        await WalletModel.decrement({ balance: totalPrice }, { where: { UserId: req.body.UserId } })
      }
      if (req.body.UserId) {
        await WalletModel.increment({ balance: totalPoints }, { where: { UserId: req.body.UserId } })
      }

      // Insert order into MongoDB
      await db.ordersCollection.insert({
        promotionalAmount: discountAmount,
        paymentId: req.body.orderDetails?.paymentId ?? null,
        addressId: req.body.orderDetails?.addressId ?? null,
        orderId,
        delivered: false,
        email: email ? email.replace(/[aeiou]/gi, '*') : undefined,
        totalPrice,
        products: basketProducts,
        bonus: totalPoints,
        deliveryPrice: deliveryAmount,
        eta: deliveryMethod.eta.toString()
      })

      doc.end()
    } catch (error) {
      next(error)
    }
  }
}

          
       
  
function calculateApplicableDiscount (basket: BasketModel, req: Request) {
  if (security.discountFromCoupon(basket.coupon ?? undefined)) {
    const discount = security.discountFromCoupon(basket.coupon ?? undefined)
    challengeUtils.solveIf(challenges.forgedCouponChallenge, () => { return (discount ?? 0) >= 80 })
    console.log(discount)
    return discount
  } else if (req.body.couponData) {
    const couponData = Buffer.from(req.body.couponData, 'base64').toString().split('-')
    const couponCode = couponData[0]
    const couponDate = Number(couponData[1])
    const campaign = campaigns[couponCode as keyof typeof campaigns]
 
    if (campaign && couponDate == campaign.validOn) { // eslint-disable-line eqeqeq
      challengeUtils.solveIf(challenges.manipulateClockChallenge, () => { return campaign.validOn < new Date().getTime() })
      return campaign.discount
    }
  }
  return 0
}



const campaigns = {
  WMNSDY2019: { validOn: new Date('Mar 08, 2019 00:00:00 GMT+0100').getTime(), discount: 75 },
  WMNSDY2020: { validOn: new Date('Mar 08, 2020 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2021: { validOn: new Date('Mar 08, 2021 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2022: { validOn: new Date('Mar 08, 2022 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2023: { validOn: new Date('Mar 08, 2023 00:00:00 GMT+0100').getTime(), discount: 60 },
  ORANGE2020: { validOn: new Date('May 04, 2020 00:00:00 GMT+0100').getTime(), discount: 50 },
  ORANGE2021: { validOn: new Date('May 04, 2021 00:00:00 GMT+0100').getTime(), discount: 40 },
  ORANGE2022: { validOn: new Date('May 04, 2022 00:00:00 GMT+0100').getTime(), discount: 40 },
  ORANGE2023: { validOn: new Date('May 04, 2023 00:00:00 GMT+0100').getTime(), discount: 40 }
}
  

