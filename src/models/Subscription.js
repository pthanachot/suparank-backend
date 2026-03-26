const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    stripeCustomerId: { type: String, required: true },
    stripeSubscriptionId: { type: String, required: true, unique: true },
    planId: {
      type: String,
      enum: ['standard-monthly', 'standard-yearly', 'pro-monthly', 'pro-yearly'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'],
      default: 'active',
    },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: Date,
    defaultPaymentMethod: {
      brand: String,
      last4: String,
      expMonth: Number,
      expYear: Number,
    },
    paymentHistory: [
      {
        invoiceId: String,
        number: String,
        amount: Number,
        currency: { type: String, default: 'USD' },
        status: String,
        description: String,
        invoiceUrl: String,
        pdfUrl: String,
        date: Date,
      },
    ],
  },
  { timestamps: true }
);

subscriptionSchema.index({ stripeCustomerId: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
