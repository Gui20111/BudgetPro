const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const planMap = {
    'price_1TT0UMR0wkFLWGjFs7XYe3Z4': 'pro',
    'price_1TT0WMR0wkFLWGjFiu0EKOAv': 'business',
  };

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0]?.price?.id;
        const plano = planMap[priceId] || 'pro';
        await db.collection('usuarios').doc(userId).set({
          plano,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          planoAtivadoEm: admin.firestore.FieldValue.serverTimestamp(),
          planoExpiraEm: new Date(subscription.current_period_end * 1000),
        }, { merge: true });
      }
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const snap = await db.collection('usuarios').where('stripeCustomerId', '==', invoice.customer).limit(1).get();
      if (!snap.empty) {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        await snap.docs[0].ref.update({
          planoExpiraEm: new Date(subscription.current_period_end * 1000),
          planoAtivo: true,
        });
      }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      const obj = event.data.object;
      const snap = await db.collection('usuarios').where('stripeCustomerId', '==', obj.customer).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ plano: 'gratuito', planoAtivo: false });
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}