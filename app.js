var mongoose = require("mongoose")
var cors = require("cors")
var express = require("express")
const bcrypt = require("bcrypt")
const axios = require("axios")
const { v4: uuidv4 } = require('uuid')

// Load environment variables
require('dotenv').config({ path: './shopping.env' });

const saltvalue = 10
const hashPassword = async (password) => {
  return await bcrypt.hash(password, saltvalue)
}
var app = express()
app.use(cors())
app.use(express.json())

const mongoURI =
  "mongodb+srv://manna:manna@cluster0.lqqm8gv.mongodb.net/shopping-app?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI).then(() => console.log("MongoDB connected"))
  .catch((err) => console.log(err));

const sellerSchema = mongoose.Schema({
  password: { type: String, required: true },
  email: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true }
})

const sellerModel = mongoose.model("seller", sellerSchema)

const customerSchema = mongoose.Schema({
  password: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true },
  phone: { type: String, trim: true }, // Added for Cashfree integration
  cart: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'product', required: true },
    quantity: { type: Number, min: 1, default: 1 , required: true }
  }]
}
)
const customerModel = mongoose.model("customer", customerSchema)

const productSchema = mongoose.Schema({
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true },
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'seller', required: true },
  sellerName: { type: String, required: true },
  link: { type: String } 
})

const productModel = mongoose.model("product", productSchema)

const orderSchema = mongoose.Schema({
  _id: { type: String, required: true }, // Using Cashfree order ID as primary key
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'customer', required: true },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'product', required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 }
  }],
  totalAmount: { type: Number, required: true },
  orderDate: { type: Date, default: Date.now },
  paymentStatus: { type: String, default: 'Pending' }
})
const orderModel = mongoose.model("order", orderSchema, 'orders') // Explicitly setting collection name

app.post("/orders", async (req, res) => {
  try {
    const { customerId, items, cashfreeOrderId, totalAmount } = req.body;

    // 1. Verify the payment with Cashfree
    const headers = {
        'x-api-version': '2022-09-01',
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY
    };

    const verificationResponse = await axios.get(
        `https://sandbox.cashfree.com/pg/orders/${cashfreeOrderId}`,
        { headers }
    );

    const orderData = verificationResponse.data;

    // 2. Check if payment is successful and amount matches
    if (orderData.order_status === 'PAID' && orderData.order_amount === totalAmount) {
        // Check stock availability before saving the order
        for (const item of items) {
            const product = await productModel.findById(item.productId);
            if (!product || product.quantity < item.quantity) {
                // This is a critical issue: payment is made but stock is unavailable.
                // You should implement a refund mechanism here.
                console.error(`Stock issue for product ${item.productId} after payment. Order ${cashfreeOrderId}`);
                return res.status(400).json({ message: `Not enough stock for ${product.name}. Please contact support for a refund.` });
            }
        }

        // 3. Create and save the order
        const newOrder = new orderModel({
            _id: cashfreeOrderId,
            customerId,
            items,
            totalAmount: orderData.order_amount,
            paymentStatus: 'Paid'
        });
        const savedOrder = await newOrder.save();

        // 4. Decrease product stock
        for (const item of items) {
            await productModel.findByIdAndUpdate(item.productId, { $inc: { quantity: -item.quantity } });
        }

        // 5. Clear the customer's cart
        await customerModel.findByIdAndUpdate(customerId, { $set: { cart: [] } });

        return res.status(201).json(savedOrder);
    } else {
        return res.status(400).json({ message: 'Payment verification failed.' });
    }
  } catch (error) {
    console.error("Error in /orders:", error.response ? error.response.data : error.message);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
});

app.post("/seller/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingSeller = await sellerModel.findOne({ email });
    if (existingSeller) {
      return res.json({ status: "used email" });
    }
    const hashedPassword = await hashPassword(password);
    const seller = new sellerModel({ name, email, password: hashedPassword });
    await seller.save();
    res.json({ status: "success" });
  } catch (e) {
    console.log(e);
    res.json({ status: "error", message: e.message });
  }
});

app.post("/seller/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    const seller = await sellerModel.findOne({ email });
    if (!seller) {
      return res.json({ status: "invalid" });
    }
    const isMatch = await bcrypt.compare(password, seller.password);
    if (!isMatch) {
      return res.json({ status: "failed" });
    }
    res.json({ status: "success", sellerId: seller._id, sellerName: seller.name });
  } catch (error) {
    res.json({ error: error.message });
  }
});
app.post("/customer/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingCustomer = await customerModel.findOne({ email });
    if (existingCustomer) {
      return res.status(409).json({ status: "error", message: "Email is already in use." });
    }
    const hashedPassword = await hashPassword(password);
    const customer = new customerModel({ name, email, password: hashedPassword, phone: req.body.phone || '' });
    await customer.save();
    res.status(201).json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: "An unexpected error occurred." });
  }
});
app.post("/customer/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    const customer = await customerModel.findOne({ email });
    if (!customer) {
      return res.status(401).json({ status: "error", message: "Invalid credentials." });
    }
    const isMatch = await bcrypt.compare(password, customer.password);
    if (isMatch) {
      return res.json({ status: "success", customerId: customer._id, name: customer.name });
    } else {
      return res.status(401).json({ status: "error", message: "Invalid credentials." });
    }
  } catch (e) {
    res.status(500).json({ status: "error", message: "An unexpected error occurred." });
  }
});

app.post('/customer/create-payment-session', async (req, res) => {
    try {
        const { customerId, totalAmount } = req.body;

        if (!customerId || !totalAmount || totalAmount <= 0) {
            return res.status(400).json({ message: 'Customer ID and a valid total amount are required.' });
        }

        const customer = await customerModel.findById(customerId);
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        const uniqueOrderId = `order_${uuidv4()}`;

        const requestData = {
            order_id: uniqueOrderId,
            order_amount: totalAmount,
            order_currency: "INR",
            customer_details: {
                customer_id: customer._id.toString(),
                customer_email: customer.email,
                customer_phone: customer.phone || "9999999999", // Using phone from schema, with a fallback
            },
            order_meta: {
                return_url: `http://localhost:3000/customer/vieworders?order_id={order_id}`,
            }
        };

        const headers = {
            'Content-Type': 'application/json',
            'x-api-version': '2022-09-01',
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET_KEY
        };

        const response = await axios.post('https://sandbox.cashfree.com/pg/orders', requestData, { headers });

        res.status(200).json({ payment_session_id: response.data.payment_session_id });
    } catch (error) {
        console.error("Error creating payment session:", error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to create payment session.' });
    }
});

app.post("/seller/addproduct", async (req, res) => {
  try {
    const product = new productModel(req.body);
    await product.save();
    res.json({ status: "success", productId: product._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/customer/viewcart", async (req, res) => {
  try {
    const { customerId } = req.body;
    const customer = await customerModel.findById(customerId).populate('cart.productId');
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.json(customer.cart);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/allproducts", async (req, res) => {
  try {
    const products = await productModel.find();
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/customer/addtocart", async (req, res) => {
  try {
    const { customerId, productId } = req.body;
    const customer = await customerModel.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const product = await productModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const cartItem = customer.cart.find(item => item.productId.toString() === productId);

    if (cartItem) {
      // Check if adding another item would exceed available stock
      if (product.quantity <= cartItem.quantity) {
        return res.status(400).json({ message: `Not enough stock for ${product.name}. Only ${product.quantity} available.` });
      }
      cartItem.quantity++;
    } else {
      // Check if product is in stock before adding it for the first time
      if (product.quantity < 1) {
        return res.status(400).json({ message: "Product is out of stock." });
      }
      customer.cart.push({ productId, quantity: 1 });
    }

    await customer.save();
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/seller/removeproduct", async (req, res) => {
  try {
    const { sellerId, productId } = req.body;
    const product = await productModel.findOne({ _id: productId, sellerId });
    if (!product) {
      return res.status(404).json({ message: "Product not found or you do not have permission to delete this product." });
    }
    await productModel.deleteOne({ _id: productId, sellerId });
    res.json({ status: "success", message: "Product deleted successfully." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/customer/removefromcart", async (req, res) => {
  try {
    const { customerId, productId } = req.body;
    const customer = await customerModel.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const cartItem = customer.cart.find(item => item.productId.toString() === productId);
    if (cartItem) {
      customer.cart.pull(cartItem._id);
      await customer.save();
      res.json({ status: "success" });
    } else {
      res.status(404).json({ message: "Item not in cart" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/seller/vieworders", async (req, res) => {
  try {
    const { sellerId } = req.body;

    if (!sellerId) {
      return res.status(400).json({ message: "sellerId is required to view orders." });
    }

    // Find all product IDs belonging to this seller
    const sellerProducts = await productModel.find({ sellerId }).select('_id');
    const sellerProductIds = sellerProducts.map(p => p._id);

    // Find all orders that contain at least one product from this seller
    const orders = await orderModel.find({ 'items.productId': { $in: sellerProductIds } })
      .populate('items.productId')
      .populate('customerId', 'name email'); // Populate only necessary customer fields
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Failed to retrieve orders", error: error.message });
  }
});
app.post("/customer/vieworders", async (req, res) => {
  try {
    const { customerId } = req.body;
    const orders = await orderModel.find({ customerId }).populate('items.productId');

    if (orders.length > 0) {
      res.json(orders);
    } else {
      res.json({ message: "No orders found for this customer." });
    }
  } catch (error) {
    res.status(500).json({ message: "Failed to retrieve orders", error: error.message });
  }
});

app.post("/searchproducts", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.json([]);
    }
    const products = await productModel.find({ name: { $regex: name.trim(), $options: 'i' } });
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () => {
  console.log("Server started on port 3001");
});