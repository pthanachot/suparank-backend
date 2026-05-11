const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    planId: {
      type: String,
      enum: [
        'free',
        'standard-monthly', 'standard-yearly',
        'professional-monthly', 'professional-yearly',
        'agency-monthly', 'agency-yearly',
        // Legacy aliases — keep for existing subscribers
        'pro-monthly', 'pro-yearly',
      ],
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
subscriptionSchema.index({ stripeSubscriptionId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);
