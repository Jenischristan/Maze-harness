def solve(n):
    total = 0
    for i in range(1, n + 1):
        total += i
    return total


def fib(k):
    if k < 2:
        return k
    return fib(k - 1) + fib(k - 2)


def count_primes(limit):
    count = 0
    for x in range(2, limit):
        prime = True
        for d in range(2, x):
            if x % d == 0:
                prime = False
                break
        if prime:
            count += 1
    return count
