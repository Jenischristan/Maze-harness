import math


def factorize(n):
    """Return the sorted list of prime factors of n (with multiplicity)."""
    factors = []
    d = 2
    while d * d <= n:
        while n % d == 0:
            factors.append(d)
            n //= d
        d += 1
    if n > 1:
        factors.append(n)
    return factors


def totient(n):
    """Euler's totient via the naive factorization above."""
    if n <= 0:
        return 0
    result = n
    for p in set(factorize(n)):
        result -= result // p
    return result


def largest_prime_gap(limit):
    """Largest gap between consecutive primes below `limit`."""
    def is_prime(x):
        if x < 2:
            return False
        for d in range(2, int(math.isqrt(x)) + 1):
            if x % d == 0:
                return False
        return True

    best = 0
    last = None
    for x in range(2, limit):
        if is_prime(x):
            if last is not None and x - last > best:
                best = x - last
            last = x
    return best
