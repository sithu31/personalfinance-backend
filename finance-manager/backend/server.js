const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());


mongoose
  .connect("mongodb://localhost:27017/personal-finance", { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ✅ User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});

const User = mongoose.model("User", userSchema);

// ✅ Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
  date: { type: Date, required: true },
  type: { type: String, enum: ["income", "expense"], required: true },
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ✅ Account Summary Schema
const accountSummarySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  totalIncome: { type: Number, required: true, default: 0 },
  totalExpenses: { type: Number, required: true, default: 0 },
  balance: { type: Number, required: true, default: 0 },
});

const AccountSummary = mongoose.model("AccountSummary", accountSummarySchema);

// ✅ Authentication Middleware
const authenticateUser = (req, res, next) => {
  const token = req.header("Authorization");
  if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

  try {
    const decoded = jwt.verify(token.replace("Bearer ", ""), "secretkey");
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(400).json({ error: "Invalid token." });
  }
};

// ✅ Update Account Summary Function (Per User)
const updateAccountSummary = async (userId) => {
  try {
    const transactions = await Transaction.find({ userId });

    const totalIncome = transactions.filter(t => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
    const totalExpenses = transactions.filter(t => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
    const balance = totalIncome - totalExpenses;

    let summary = await AccountSummary.findOne({ userId });
    if (!summary) {
      summary = new AccountSummary({ userId, totalIncome, totalExpenses, balance });
    } else {
      summary.totalIncome = totalIncome;
      summary.totalExpenses = totalExpenses;
      summary.balance = balance;
    }

    await summary.save();
  } catch (error) {
    console.error("❌ Error updating account summary:", error);
  }
};



// ✅ GET - Fetch all transactions (Sorted by Date)
app.get("/api/transactions", authenticateUser, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.userId }).sort({ date: -1 });
    res.status(200).json(transactions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ✅ GET - Fetch Account Summary
app.get("/api/account-summary", authenticateUser, async (req, res) => {
  try {
    let summary = await AccountSummary.findOne({ userId: req.userId });

    if (!summary) {
      summary = new AccountSummary({ userId: req.userId, totalIncome: 0, totalExpenses: 0, balance: 0 });
      await summary.save();
    }

    res.status(200).json(summary);
  } catch (error) {
    res.status(500).json({ error: "Failed to load account summary" });
  }
});
app.get("/api/budget-suggestion", authenticateUser, async (req, res) => {
  try {
    // Fetch account summary for the user
    const summary = await AccountSummary.findOne({ userId: req.userId });
    if (!summary) {
      return res.status(404).json({ error: "No account summary found." });
    }

    // Use Account Summary values to avoid inconsistencies
    let totalIncome = summary.totalIncome; // Use correct income
    let totalExpenses = summary.totalExpenses; // Use correct expenses

    // Fetch user's transactions
    const transactions = await Transaction.find({ userId: req.userId });

    if (transactions.length === 0) {
      return res.json({ suggestion: "No transactions found to generate suggestions." });
    }

    let categoryTotals = {};

    // Process transactions for category-wise expense analysis
    transactions.forEach((transaction) => {
      if (transaction.type === "expense") {
        categoryTotals[transaction.category] = (categoryTotals[transaction.category] || 0) + transaction.amount;
      }
    });

    // Find highest spending category
    const highestSpendingCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];

    let suggestion = highestSpendingCategory
      ? `You are spending the most on ${highestSpendingCategory[0]} ($${highestSpendingCategory[1].toFixed(2)}). Consider reducing expenses in this category.`
      : "Your spending is well-balanced. Keep it up!";

    // Calculate remaining balance and suggested savings
    const remainingBalance = summary.balance;
    const suggestedSavings = remainingBalance * 0.2; // Suggest saving 20% of balance

    if (remainingBalance < 0) {
      suggestion += " ⚠️ Your expenses exceed your income. Reduce unnecessary spending.";
    } else if (suggestedSavings > 50) {
      suggestion += ` 💰 Try saving at least $${suggestedSavings.toFixed(2)} this month.`;
    }

    // **Investment Recommendations Based on Savings**
    let investmentAdvice;
    if (suggestedSavings >= 500) {
      investmentAdvice = "Consider diversified investments: stocks, ETFs, and long-term mutual funds.";
    } else if (suggestedSavings >= 200) {
      investmentAdvice = "Try mutual funds or low-risk bonds for steady growth.";
    } else if (suggestedSavings >= 100) {
      investmentAdvice = "Consider a high-yield savings account or small recurring deposits.";
    } else {
      investmentAdvice = "Start by building an emergency fund before investing.";
    }

    res.json({
      totalIncome,
      totalExpenses,
      remainingBalance: remainingBalance.toFixed(2),
      suggestedSavings: suggestedSavings.toFixed(2),
      highestSpendingCategory: highestSpendingCategory ? highestSpendingCategory[0] : "None",
      suggestion,
      investmentAdvice,
    });

  } catch (error) {
    console.error("❌ Error fetching budget suggestion:", error);
    res.status(500).json({ error: "Failed to generate budget suggestion." });
  }
});

// ✅ POST - Add a new transaction
app.post("/api/transactions", authenticateUser, async (req, res) => {
  try {
    const { amount, description, category, date, type } = req.body;

    if (!amount || !description || !category || !date || !type) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const newTransaction = new Transaction({ userId: req.userId, amount, description, category, date, type });
    await newTransaction.save();

    await updateAccountSummary(req.userId);

    res.status(201).json({ message: "Transaction added successfully!", transaction: newTransaction });
  } catch (error) {
    res.status(500).json({ error: "Failed to add transaction" });
  }
});
// ✅ PUT - Update a transaction by ID
app.put('/api/transactions/:id', authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, description, category, date, type } = req.body;

    // ✅ Find the existing transaction
    const existingTransaction = await Transaction.findById(id);
    if (!existingTransaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // ✅ Find the user's account summary
    let summary = await AccountSummary.findOne({ userId: req.userId });
    if (!summary) {
      summary = new AccountSummary({ userId: req.userId, totalIncome: 0, totalExpenses: 0, balance: 0 });
    }

    // ✅ Adjust totals before updating
    if (existingTransaction.type === "income") {
      summary.totalIncome -= existingTransaction.amount; // Remove old income
    } else if (existingTransaction.type === "expense") {
      summary.totalExpenses -= existingTransaction.amount; // Remove old expense
    }

    // ✅ Update transaction details
    existingTransaction.amount = amount;
    existingTransaction.description = description;
    existingTransaction.category = category;
    existingTransaction.date = date;
    existingTransaction.type = type;

    await existingTransaction.save();

    // ✅ Adjust totals after updating
    if (type === "income") {
      summary.totalIncome += amount; // Add new income
    } else if (type === "expense") {
      summary.totalExpenses += amount; // Add new expense
    }

    // ✅ Recalculate balance
    summary.balance = summary.totalIncome - summary.totalExpenses;

    // ✅ Save updated summary
    await summary.save();

    res.status(200).json({ 
      message: "Transaction updated successfully!", 
      transaction: existingTransaction, 
      summary 
    });

  } catch (error) {
    console.error("❌ Error updating transaction:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});



// ✅ DELETE - Remove a transaction by ID
app.delete("/api/transactions/:id", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const deletedTransaction = await Transaction.findOneAndDelete({ _id: id, userId: req.userId });

    if (!deletedTransaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    await updateAccountSummary(req.userId);

    res.status(200).json({ message: "Transaction deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ User Registration (Signup)
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "Email already registered!" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: "User registered successfully!" });
  } catch (error) {
    res.status(500).json({ error: "Failed to register user" });
  }
});

// ✅ User Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: "Invalid email or password!" });
    }

    const token = jwt.sign({ userId: user._id }, "secretkey", { expiresIn: "1h" });
    res.status(200).json({ message: "Login successful!", token });
  } catch (error) {
    res.status(500).json({ error: "Failed to log in" });
  }
});

app.listen(4000, () => {
    console.log("Server is running on port 4000 http://127.0.0.1:4000");
  });